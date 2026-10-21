import { productionBoundaries } from "./production-capabilities.mjs";
import { readNames, operationNames, deferredReadNames, eligibleOperation, operationSchema, discoverProductionTools, productionSchemas } from "./production-tool-catalog.mjs";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { toolContracts } from "./tool-contracts.mjs";
import { producerToolContracts } from "./producer-contracts.mjs";
import { validateToolArguments } from "./tool-validation.mjs";
import { createProducerRuntime, parseProducerResponse } from "./producer-runtime.mjs";
import { requestSignal, withRequestSignal } from "./request-context.mjs";
import { getProducerWorkflow } from "./prompts.mjs";
import { ProductionSessions } from "./production-sessions.mjs";
import { assertProducerScope, validateProducerScope } from "./producer-scope.mjs";
import { classifyMutationOutcome } from "./mutation-outcomes.mjs";
import { assessTaskCompletion } from "./production-task-completion.mjs";

const roles = ["creative", "functional"];
const checkSignal = () => requestSignal()?.throwIfAborted();
const identity = value => ({ stateVersion: value.stateVersion, setFingerprint: value.setFingerprint });
const sameState = (left, right) => left.stateVersion === right.stateVersion && left.setFingerprint === right.setFingerprint;

const stableSessionObservation = value => JSON.parse(JSON.stringify(value, (key, item) =>
  ["stateVersion", "setFingerprint", "isPlaying", "isTriggered", "playingPosition"].includes(key) ? undefined : item));
function validateSessionScope(scope = {}) {
  validateProducerScope(scope);
  if ((scope.clipId || scope.deviceId) && !scope.trackId) throw new Error("clip and device session scopes require trackId");
  if (scope.clipId && !scope.trackId.startsWith("track-")) throw new Error("clip session scope requires an ordinary track owner");
}


export class ProducerService {
  #queue = Promise.resolve();
  #activeTasks = 0;
  constructor({ service, artifacts, config, runtimeFactory = createProducerRuntime }) {
    this.service = service; this.artifacts = artifacts; this.config = config; this.runtimeFactory = runtimeFactory;
    this.sessions = new ProductionSessions({ artifacts, context: (projectId, scope) => this.#sessionContext(projectId, scope),
      run: args => this.#run(args), apply: args => this.#serialized(() => this.#apply(args)),
      verify: (projectId, checks) => this.#checks(projectId, checks) });
  }

  discoveryExamples() { return this.service.discoveryExamples?.(); }
  get bridge() { return this.service.bridge; }
  get browserMetadata() { return this.service.browserMetadata; }
  readResource(uri) { return this.service.readResource(uri); }

  async call(name, args = {}) {
    checkSignal();
    if (!Object.hasOwn(producerToolContracts, name)) {
      return toolContracts[name]?.annotations.readOnlyHint ? this.service.call(name, args) : this.#serialized(() => this.service.call(name, args));
    }
    validateToolArguments(name, args);
    const { projectId } = args;
    if (name === "get_production_session") return this.sessions.get(args);
    if (name === "advance_production_session") return this.sessions.advance(args);
    if (name === "start_production_session") {
      validateSessionScope(args.scope);
      if (args.postconditions) this.#validatePostconditions(args.postconditions, args.scope || {});
      if (args.workflow) getProducerWorkflow({ workflow: args.workflow.name, arguments: args.workflow.arguments });
      return this.sessions.start(args);
    }
    if (name === "read_production_artifact") return this.artifacts.page(projectId, args.artifactId, args.offset, args.limit);
    if (name === "record_production_note") {
      for (const id of args.contextRefs || []) this.artifacts.get(projectId, id);
      return { noteRef: this.artifacts.put(projectId, args.kind, { text: args.text, contextRefs: args.contextRefs || [] }) };
    }
    if (name === "get_production_context") return this.#context(projectId);
    if (name === "run_production_task") return this.#run(args);
    return this.#serialized(() => this.#apply(args));
  }

  #serialized(callback) {
    const result = this.#queue.then(() => { checkSignal(); return callback(); });
    this.#queue = result.catch(() => {});
    return result;
  }

  async #live() {
    checkSignal();
    const live = await this.service.call("get_live_state", {});
    if (!Number.isInteger(live.stateVersion) || typeof live.setFingerprint !== "string") throw new Error("Live did not return a versioned Set identity");
    return live;
  }

  async #context(projectId) {
    const before = await this.#live();
    const selection = await this.service.call("get_selection_context", {});
    const musical = await this.service.call("get_song_musical_context", {});
    const after = await this.#live();
    if (!sameState(before, after)) throw new Error("Live context changed during observation; read again");
    const contextRef = this.artifacts.put(projectId, "context", { live: before, selection, musical });
    return { ...identity(before), contextRef, summary: "Live selection and musical context captured.",
      preview: JSON.stringify({ selection, musical }).slice(0, 1800), previewTruncated: JSON.stringify({ selection, musical }).length > 1800 };
  }

  async #sessionContext(projectId, scope = {}) {
    validateSessionScope(scope);
    const observed = await this.#context(projectId);
    const context = this.artifacts.get(projectId, observed.contextRef).value, live = context.live;
    if (!live.filePath) throw new Error("Save the Live Set before starting or resuming a durable production session");
    const initialSong = stableSessionObservation({ tempo: live.tempo, musical: context.musical });
    const snapshot = async () => {
      const songLive = await this.#live();
      const values = { song: { tempo: songLive.tempo, musical: await this.service.call("get_song_musical_context", {}) } };
      if (scope.trackId) {
        if (scope.trackId === "master" || scope.trackId.startsWith("return-")) {
          const buses = await this.service.call("get_set_mixer", {});
          values.mixer = scope.trackId === "master" ? buses.master : buses.returns?.find(row => row.id === scope.trackId);
          if (!values.mixer) throw new Error(`session Main or Return owner is unavailable: ${scope.trackId}`);
          if (scope.trackId !== "master") values.routing = await this.service.call("get_return_routing", {returnTrackId:scope.trackId});
        } else {
          values.mixer = await this.service.call("get_track_mixer", { trackId: scope.trackId });
          values.routing = await this.service.call("get_track_routing", { trackId: scope.trackId });
        }
        values.devices = await this.service.call("list_devices", { trackId: scope.trackId });
      }
      if (scope.clipId) {
        const target = { trackId: scope.trackId, clipId: scope.clipId };
        values.timing = await this.service.call("get_clip_timing", target);
        try { values.clip = await this.service.call("get_midi_clip_notes_extended", target); }
        catch (error) {
          if (!/not a MIDI clip/.test(error.message)) throw error;
          values.clip = await this.service.call("get_audio_clip_state", target);
        }
      }
      if (scope.deviceId) values.parameters = await this.service.call("list_device_parameters", { trackId: scope.trackId, deviceId: scope.deviceId });
      // Transport and selection do not define the target's musical content.
      return stableSessionObservation(values);
    };
    const first = await snapshot(), second = await snapshot(), after = await this.#live();
    if (!sameState(observed, after) || live.filePath !== after.filePath || live.tempo !== after.tempo ||
        !isDeepStrictEqual(initialSong, second.song) || !isDeepStrictEqual(first, second))
      throw new Error("session target changed during observation; read again");
    const targetRef = this.artifacts.put(projectId, "session-target", { scope, observations: second });
    return { ...observed, documentPath: live.filePath, targetRef,
      targetHash: createHash("sha256").update(JSON.stringify(second)).digest("hex") };
  }

  async #checks(projectId, checks) {
    const results = [];
    for (const check of checks) {
      checkSignal();
      const observed = await this.service.call(check.tool, check.args);
      let field = observed;
      for (const key of check.path) field = field !== null && typeof field === "object" && Object.hasOwn(field, key) ? field[key] : undefined;
      results.push({ tool: check.tool, path: check.path, matches: isDeepStrictEqual(field, check.expected),
        observationRef: this.artifacts.put(projectId, "postcondition", { check, observed }) });
    }
    return results;
  }

  #preview(projectId, artifactId) {
    const record = this.artifacts.get(projectId, artifactId);
    const value = record.kind === "context" ? {
      live: { ...identity(record.value.live), tempo: record.value.live.tempo, isPlaying: record.value.live.isPlaying },
      selection: record.value.selection,
      musical: { key: record.value.musical.key, timeSignature: record.value.musical.timeSignature }
    } : record.value;
    const text = JSON.stringify(value);
    return { artifactId, kind: record.kind, text: text.slice(0, 1800), truncated: text.length > 1800 };
  }

  #validateRead(read, scope, allowedReads = readNames) {
    if (!allowedReads.includes(read.tool)) throw new Error(`specialist read tool is not allowed: ${read.tool}`);
    validateToolArguments(read.tool, read.args);
    assertProducerScope(read.tool, read.args, scope);
  }

  #validatePostconditions(checks, scope) {
    for (const check of checks) {
      if (Object.hasOwn(producerToolContracts, check.tool) || !toolContracts[check.tool]?.annotations.readOnlyHint)
        throw new Error(`postcondition tool must be read-only: ${check.tool}`);
      this.#validateRead(check, scope, [check.tool]);
    }
  }

  #validateProposal(result, role, scope, allowedReads = readNames, allowedOperations = operationNames, intent = "change") {
    // Injected runtimes and ACP peers follow the same response contract.
    parseProducerResponse(JSON.stringify(result));
    if (intent === "inspect" && (result.operations.length || result.reads.some(read =>
      read.tool === "discover_production_tools" && read.args.kind === "operation")))
      throw new Error("inspection tasks cannot discover or propose operations");
    for (const read of result.reads) {
      if (read.tool === "read_production_artifact") continue;
      if (read.tool === "discover_production_tools") { this.#discover(read.args, role); continue; }
      this.#validateRead(read, scope, allowedReads);
    }
    if (role === "creative" && (result.operations.length || result.checks.length)) throw new Error("creative execution proposals are not allowed");
    for (const operation of result.operations) {
      if (!allowedOperations.includes(operation.tool) || !eligibleOperation(operation.tool))
        throw new Error(`specialist operation is not allowed: ${operation.tool}`);
      validateToolArguments(operation.tool, { ...operation.args, expectedStateVersion: 1 });
      assertProducerScope(operation.tool, operation.args, scope, { write: true });
    }
    for (const check of result.checks) this.#validateRead(check, scope, allowedReads);
  }

  #discover(args, role) { return discoverProductionTools(args, role); }

  async #run(args) {
    validateProducerScope(args.scope);
    if (this.#activeTasks >= 2) throw new Error("two specialist tasks are already active; cancel or await one before starting another");
    this.#activeTasks++;
    try { return await this.#runTask(args); }
    finally { this.#activeTasks--; }
  }

  async #runTask(args) {
    const workflow=args.workflow?getProducerWorkflow({workflow:args.workflow.name,arguments:args.workflow.arguments}):null;
    const postconditions = args.postconditions === undefined ? null : structuredClone(args.postconditions);
    if (postconditions) this.#validatePostconditions(postconditions, args.scope || {});
    const selected = args.roles === "both" ? roles : [args.roles || "functional"];
    for (const role of selected) if (!this.config?.[role]) throw new Error(`${role} specialist is not configured`);
    const signal = requestSignal();
    const deadline = AbortSignal.timeout(180000);
    const taskSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    return withRequestSignal(taskSignal, async () => {
      const { projectId, goal, scope = {}, constraints = [], intent = "change" } = args;
      const observed = await this.#context(projectId);
      const workflowRef=workflow?this.artifacts.put(projectId,"workflow",{selection:args.workflow,guidance:workflow}):null;
      const checkMetadata = { checkSource: postconditions ? "caller" : "specialist",
        ...(postconditions ? { postconditionsRef: this.artifacts.put(projectId, "postconditions", postconditions) } : {}) };
      const contextRefs = [...new Set([observed.contextRef, ...(args.contextRefs || [])])];
      for (const ref of contextRefs) this.artifacts.get(projectId, ref);
      const sessionRoot = join(this.artifacts.directory, ".sessions");
      mkdirSync(sessionRoot, { recursive: true, mode: 0o700 });
      const results = [], turnRefs = []; let exhausted = false, reads = 0, discoveries = 0, stopReason;
      const hasDeferredRole = selected.some(role => this.config[role].toolDiscovery === "deferred");
      const initialReads = [...new Set([...readNames, ...(postconditions || []).map(check => check.tool)])];
      const allowedReads = [...initialReads], allowedOperations = [...operationNames];
      for (const role of selected) {
        checkSignal();
        const cwd = mkdtempSync(join(sessionRoot, `${role}-`));
        try {
          const runtime = this.runtimeFactory(this.config[role]);
          const deferred = this.config[role].toolDiscovery === "deferred";
          const maxTurns = deferred ? 6 : 3;
          const roleReads = deferred ? [...new Set([...deferredReadNames, ...(postconditions || []).map(check => check.tool)])] : initialReads;
          const packet = { role, intent, goal, scope, constraints, capabilities: { ...productionBoundaries }, context: contextRefs.map(ref => this.#preview(projectId, ref)),
            ...(workflow?{workflow}:{}),
            ...(postconditions ? { postconditions: structuredClone(postconditions) } : {}),
            tools: productionSchemas({ role, initialReads: roleReads, deferred, intent, goal }), progress: { completedReads: [] },
            ...(role === "functional" && results.length ? { creativeProposal: results[0].result } : {}) };
          for (const tool of packet.tools.reads) if (!allowedReads.includes(tool.name)) allowedReads.push(tool.name);
          for (const tool of packet.tools.operations) if (!allowedOperations.includes(tool.name)) allowedOperations.push(tool.name);
          for (let round = 0; round < maxTurns; round++) {
            checkSignal();
            Object.assign(packet.progress, { turn: round + 1, maxTurns, readsRemaining: 8 - reads,
              ...(deferred ? { discoveriesRemaining: 8 - discoveries } : {}) });
            if (Buffer.byteLength(JSON.stringify(packet)) > 48000) { exhausted = true; stopReason = "input_limit"; break; }
            const inputRef = this.artifacts.put(projectId, "specialist-input", packet);
            const result = await runtime.generate(packet, { signal: taskSignal, cwd });
            checkSignal(); this.#validateProposal(result, role, scope,
              deferred ? packet.tools.reads.map(tool => tool.name) : allowedReads,
              deferred ? packet.tools.operations.map(tool => tool.name) : allowedOperations, intent);
            const resultRef = this.artifacts.put(projectId, "specialist-result", { role, result, inputRef,
              runtime: { type: this.config[role].type, model: this.config[role].model || null } });
            turnRefs.push({ role, turn: round + 1, inputRef, resultRef });
            packet.progress.previousResultRef = resultRef;
            packet.progress.previousResponse = result;
            if (!result.reads.length) { results.push({ role, result, resultRef }); break; }
            const discoveryCount = deferred ? result.reads.filter(read => read.tool === "discover_production_tools").length : 0;
            const readCount = result.reads.length - discoveryCount;
            if (round === maxTurns - 1 || reads + readCount > 8 || discoveries + discoveryCount > 8) {
              exhausted = true; stopReason = round === maxTurns - 1 ? "model_turn_limit"
                : reads + readCount > 8 ? "read_limit" : "discovery_limit"; break;
            }
            for (const read of result.reads) {
              checkSignal();
              if (deferred && read.tool === "discover_production_tools") discoveries++;
              else reads++;
              if (read.tool === "discover_production_tools") {
                const found = this.#discover(read.args, role);
                const target = read.args.kind === "read" ? packet.tools.reads : packet.tools.operations;
                const allowed = read.args.kind === "read" ? allowedReads : allowedOperations;
                for (const name of found.names) {
                  if (!allowed.includes(name)) allowed.push(name);
                  if (!target.some(tool => tool.name === name)) target.push(read.args.kind === "operation" ? operationSchema(name)
                    : { name, inputSchema: toolContracts[name].inputSchema });
                }
                packet.context.push({ discovery: { ...read.args, ...found } });
                packet.progress.completedReads.push({ ...read, discovery: found });
              } else if (read.tool === "read_production_artifact") {
                const readArgs = { ...read.args, projectId };
                validateToolArguments(read.tool, readArgs);
                if (!contextRefs.includes(readArgs.artifactId) &&
                    !turnRefs.some(turn => turn.role === role && turn.resultRef === readArgs.artifactId))
                  throw new Error("artifact read is outside task context");
                const page = this.artifacts.page(projectId, readArgs.artifactId, readArgs.offset, readArgs.limit);
                packet.context.push(page);
                packet.progress.completedReads.push({ ...read, nextOffset: page.nextOffset });
              } else {
                const value = await this.service.call(read.tool, read.args);
                const ref = this.artifacts.put(projectId, "observation", { tool: read.tool, args: read.args, value });
                contextRefs.push(ref); packet.context.push(this.#preview(projectId, ref));
                packet.progress.completedReads.push({ ...read, artifactId: ref });
              }
            }
          }
        } finally { rmSync(cwd, { recursive: true, force: true }); }
        if (exhausted) break;
      }
      const questions = results.flatMap(value => value.result.questions);
      const functional = results.find(value => value.role === "functional")?.result;
      const completion = !exhausted && !questions.length ? await assessTaskCompletion({ intent, functional, postconditions,
        verify: checks => this.#checks(projectId, checks) }) : {};
      const after = await this.#live();
      const stale = !sameState(observed, after);
      const status = exhausted ? "budget_exhausted" : stale ? "stale_context" : questions.length ? "needs_input" : completion.status;
      if (status === "incomplete") stopReason = completion.stopReason;
      if (completion.checks || completion.error) checkMetadata.completionRef = this.artifacts.put(projectId, "task-completion", {
        ...completion, status, basis: identity(observed), observedAfter: identity(after) });
      checkMetadata.suggestedCheckCount = functional?.checks.length || 0;
      const operations = status === "proposed" ? functional?.operations || [] : [];
      const taskId = this.artifacts.put(projectId, "task", { goal, intent, scope, constraints, basis: identity(observed), observedAfter: identity(after), contextRefs,
        ...(hasDeferredRole ? { discoveriesUsed: discoveries } : {}),
        ...(workflowRef?{workflowRef}:{}),
        results, turnRefs, status, ...checkMetadata, ...(stopReason ? { stopReason } : {}), operations,
        checks: postconditions || functional?.checks || [], allowedReads, allowedOperations, createdAt: new Date().toISOString() });
      return { taskId, intent, status, ...checkMetadata, ...(stopReason ? { stopReason } : {}),
        summary: (exhausted || status === "incomplete" ? `Specialist stopped at ${stopReason}; no executable proposal.` : results.at(-1)?.result.summary || "No specialist proposal.").slice(0, 1000),
        ...(workflowRef?{workflowRef}:{}),
        ...identity(observed), operationCount: operations.length, questions: questions.slice(0, 4).map(question => question.slice(0, 300)),
        questionsTruncated: questions.length > 4 || questions.some(question => question.length > 300),
        resultRefs: results.map(value => ({ role: value.role, artifactId: value.resultRef })),
        contextRef: observed.contextRef, readsUsed: reads, ...(hasDeferredRole ? { discoveriesUsed: discoveries } : {}), turnRefs };
    });
  }

  async #apply(args) {
    const { projectId, taskId, operationIndex, expectedStateVersion } = args;
    const taskRecord = this.artifacts.get(projectId, taskId);
    if (taskRecord.kind !== "task" || taskRecord.value.status !== "proposed") throw new Error("task is incomplete or not executable");
    const task = taskRecord.value;
    validateProducerScope(task.scope);
    const checkMetadata = { checkSource: task.checkSource || "specialist", suggestedCheckCount: task.suggestedCheckCount ?? task.checks.length,
      ...(task.postconditionsRef ? { postconditionsRef: task.postconditionsRef } : {}) };
    if (checkMetadata.checkSource === "caller") {
      const declared = this.artifacts.get(projectId, task.postconditionsRef);
      if (declared.kind !== "postconditions" || !isDeepStrictEqual(declared.value, task.checks)) throw new Error("task postconditions do not match their saved reference");
      this.#validatePostconditions(task.checks, task.scope);
    }
    const operation = task.operations[operationIndex];
    if (!operation) throw new Error("operation index is outside this task");
    let basis = task.basis;
    if (operationIndex > 0) {
      if (!args.previousReceiptId) throw new Error("preceding applied receipt is required");
      const record = this.artifacts.get(projectId, args.previousReceiptId);
      const receipt = record.value;
      if (record.kind !== "receipt" || receipt.taskId !== taskId || receipt.operationIndex !== operationIndex - 1 || receipt.status !== "applied")
        throw new Error("preceding receipt does not match this operation");
      basis = receipt.after;
    } else if (args.previousReceiptId) throw new Error("first operation does not accept a preceding receipt");
    const before = await this.#live();
    if (!sameState(before, basis) || before.stateVersion !== expectedStateVersion) throw new Error("task state is stale; observe and propose again");
    this.#validateProposal({ summary: "Validate saved operation", reads: [], operations: [operation], checks: task.checks, questions: [], alternatives: [] },
      "functional", task.scope, task.allowedReads, task.allowedOperations);
    const callArgs = { ...operation.args, expectedStateVersion, dryRun: args.dryRun !== false };
    if (args.dryRun === false) {
      if (!args.confirmationToken || !args.planHash) throw new Error("execution requires the original confirmation token and plan hash");
      callArgs.confirmationToken = args.confirmationToken; callArgs.planHash = args.planHash;
    }
    validateToolArguments(operation.tool, callArgs);
    checkSignal();
    let value;
    try { value = await this.service.call(operation.tool, callArgs); }
    catch (error) {
      if (args.dryRun !== false) throw error;
      const status = error.outcome === "not_executed" ? "rejected" : "outcome_unknown";
      const receiptId = this.artifacts.put(projectId, "receipt", { taskId, operationIndex, status, ...checkMetadata,
        error: error.message, outcome: error.outcome || null });
      return { taskId, operationIndex, status, ...checkMetadata, outcome: error.outcome || "unknown", receiptId,
        message: "Inspect Live and the receipt before proposing further changes; execution is not retried." };
    }
    const resultRef = this.artifacts.put(projectId, "operation-result", value);
    if (args.dryRun !== false) return { taskId, operationIndex, status: "planned", ...checkMetadata, tool: operation.tool,
      ...(JSON.stringify(operation.args).length <= 2000 ? { arguments: operation.args }
        : { argumentsOmitted: true, reviewRequired: "Read the planRef artifact for complete proposed arguments before confirming." }),
      planRef: resultRef, confirmationToken: value.confirmation?.token,
      planHash: value.confirmation?.planHash, expiresAt: value.confirmation?.expiresAt };
    const checks = []; let after, observationError;
    try {
      if (operationIndex === task.operations.length - 1) {
        checks.push(...await this.#checks(projectId, task.checks));
      }
      after = await this.#live();
    } catch (error) { observationError = error.message; }
    const operationOutcome = classifyMutationOutcome(operation.tool, callArgs, value);
    const nativeVerificationFailed = operationOutcome.status === "outcome_unknown";
    const nativeMetadata = nativeVerificationFailed ? {nativeVerificationFailed:true} : {};
    const status = observationError ? "outcome_unknown" : operationOutcome.status !== "applied" ? operationOutcome.status
      : checks.some(check => !check.matches) ? "postconditions_failed" : "applied";
    const receiptId = this.artifacts.put(projectId, "receipt", { taskId, operationIndex, status, ...checkMetadata, ...nativeMetadata, operationOutcome, after, checks, resultRef, observationError });
    return { taskId, operationIndex, status, ...checkMetadata, ...nativeMetadata, receiptId, resultRef, ...(after ? identity(after) : {}), checks,
      operationOutcome, verification: checks.length ? "declared_field_checks" : "operation_response_and_state_readback", audibleQualityVerified: false };
  }
}
