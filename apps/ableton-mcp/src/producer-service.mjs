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
import { assertProducerScope } from "./producer-scope.mjs";

const readNames = ["get_live_state", "get_selection_context", "get_song_musical_context", "list_tracks", "list_clips",
  "list_devices", "list_device_parameters", "get_device_parameter_edit_context", "get_clip_timing",
  "get_midi_clip_notes_extended", "get_audio_clip_state", "get_track_mixer", "get_track_routing",
  "get_factory_device_context", "get_plugin_integration_context", "analyze_midi_clip_scale", "analyze_midi_clip_chords"];
const operationNames = ["set_tempo", "set_song_musical_context", "set_device_parameters", "set_track_mixer", "set_track_volume_db", "set_track_send_db",
  "set_clip_timing", "set_audio_clip_state", "set_midi_note_properties", "transform_midi_notes",
  "duplicate_midi_clip_variations", "create_midi_clip", "set_device_active", "set_session_clip_entry"];
const executionFields = ["dryRun", "confirmationToken", "planHash", "expectedStateVersion"];
const roles = ["creative", "functional"];
const checkSignal = () => requestSignal()?.throwIfAborted();
const identity = value => ({ stateVersion: value.stateVersion, setFingerprint: value.setFingerprint });
const sameState = (left, right) => left.stateVersion === right.stateVersion && left.setFingerprint === right.setFingerprint;
const eligibleOperation = name => !Object.hasOwn(producerToolContracts, name) &&
  Boolean(toolContracts[name]?.inputSchema.properties.expectedStateVersion && toolContracts[name]?.inputSchema.properties.dryRun);
const stableSessionObservation = value => JSON.parse(JSON.stringify(value, (key, item) =>
  ["stateVersion", "setFingerprint", "isPlaying", "isTriggered", "playingPosition"].includes(key) ? undefined : item));
function validateSessionScope(scope = {}) {
  if (scope.trackId !== undefined && !/^(?:master|(?:track|return)-(?:0|[1-9][0-9]*))$/.test(scope.trackId))
    throw new Error("session scope requires a canonical ordinary, Group, Return or Main owner");
  if ((scope.clipId || scope.deviceId) && !scope.trackId) throw new Error("clip and device session scopes require trackId");
  if (scope.clipId && !scope.trackId.startsWith("track-")) throw new Error("clip session scope requires an ordinary track owner");
}
function operationSchema(name) {
  const schema = structuredClone(toolContracts[name].inputSchema);
  for (const key of executionFields) delete schema.properties[key];
  schema.required = (schema.required || []).filter(key => !executionFields.includes(key));
  return { name, inputSchema: schema };
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

  #validateProposal(result, role, scope, allowedReads = readNames, allowedOperations = operationNames) {
    // Injected runtimes and ACP peers follow the same response contract.
    parseProducerResponse(JSON.stringify(result));
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

  #discover(args, role) {
    if (Object.keys(args).some(key => !["query", "kind", "offset"].includes(key)) ||
        typeof args.query !== "string" || args.query.trim().length < 2 || args.query.length > 120 ||
        !["read", "operation"].includes(args.kind) ||
        (args.offset !== undefined && (!Number.isInteger(args.offset) || args.offset < 0 || args.offset > 10000)))
      throw new Error("invalid tool discovery arguments");
    if (role === "creative" && args.kind !== "read") throw new Error("creative operation discovery is not allowed");
    const words = args.query.toLowerCase().replaceAll("_", " ").split(/\s+/).filter(Boolean);
    const matches = Object.entries(toolContracts).filter(([name, contract]) => {
      if (Object.hasOwn(producerToolContracts, name)) return false;
      if (args.kind === "operation" ? !eligibleOperation(name) : !contract.annotations.readOnlyHint) return false;
      const text = `${name.replaceAll("_", " ")} ${contract.description}`.toLowerCase();
      return words.every(word => text.includes(word));
    }).map(([name]) => name).sort();
    const offset = args.offset || 0;
    return { names: matches.slice(offset, offset + 4), total: matches.length,
      nextOffset: offset + 4 < matches.length ? offset + 4 : null };
  }

  #schemas(role, initialReads = readNames) {
    const operations = role === "functional" ? operationNames.filter(eligibleOperation).map(operationSchema) : [];
    return { reads: initialReads.filter(name => toolContracts[name]).map(name => ({ name, inputSchema: toolContracts[name].inputSchema })), operations,
      discovery: { tool: "discover_production_tools", args: { query: "words from the tool name or description", kind: "read or operation", offset: 0 },
        description: "Find at most four additional tool schemas. Creative may discover reads only. Operations are proposed, never executed by a specialist." },
      artifactRead: { tool: "read_production_artifact", args: { artifactId: "ID present in this task", offset: 0, limit: 4000 } } };
  }

  async #run(args) {
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
      const { projectId, goal, scope = {}, constraints = [] } = args;
      const observed = await this.#context(projectId);
      const workflowRef=workflow?this.artifacts.put(projectId,"workflow",{selection:args.workflow,guidance:workflow}):null;
      const checkMetadata = { checkSource: postconditions ? "caller" : "specialist",
        ...(postconditions ? { postconditionsRef: this.artifacts.put(projectId, "postconditions", postconditions) } : {}) };
      const contextRefs = [...new Set([observed.contextRef, ...(args.contextRefs || [])])];
      for (const ref of contextRefs) this.artifacts.get(projectId, ref);
      const sessionRoot = join(this.artifacts.directory, ".sessions");
      mkdirSync(sessionRoot, { recursive: true, mode: 0o700 });
      const results = [], turnRefs = []; let exhausted = false, reads = 0, stopReason;
      const initialReads = [...new Set([...readNames, ...(postconditions || []).map(check => check.tool)])];
      const allowedReads = [...initialReads], allowedOperations = [...operationNames];
      for (const role of selected) {
        checkSignal();
        const cwd = mkdtempSync(join(sessionRoot, `${role}-`));
        try {
          const runtime = this.runtimeFactory(this.config[role]);
          const packet = { role, goal, scope, constraints, context: contextRefs.map(ref => this.#preview(projectId, ref)),
            ...(workflow?{workflow}:{}),
            ...(postconditions ? { postconditions: structuredClone(postconditions) } : {}),
            tools: this.#schemas(role, initialReads), progress: { completedReads: [] },
            ...(role === "functional" && results.length ? { creativeProposal: results[0].result } : {}) };
          for (let round = 0; round < 3; round++) {
            checkSignal();
            Object.assign(packet.progress, { turn: round + 1, maxTurns: 3, readsRemaining: 8 - reads });
            if (Buffer.byteLength(JSON.stringify(packet)) > 48000) { exhausted = true; stopReason = "input_limit"; break; }
            const inputRef = this.artifacts.put(projectId, "specialist-input", packet);
            const result = await runtime.generate(packet, { signal: taskSignal, cwd });
            checkSignal(); this.#validateProposal(result, role, scope, allowedReads, allowedOperations);
            const resultRef = this.artifacts.put(projectId, "specialist-result", { role, result, inputRef,
              runtime: { type: this.config[role].type, model: this.config[role].model || null } });
            turnRefs.push({ role, turn: round + 1, inputRef, resultRef });
            packet.progress.previousResultRef = resultRef;
            packet.progress.previousResponse = result;
            if (!result.reads.length) { results.push({ role, result, resultRef }); break; }
            if (round === 2 || reads + result.reads.length > 8) {
              exhausted = true; stopReason = round === 2 ? "model_turn_limit" : "read_limit"; break;
            }
            for (const read of result.reads) {
              checkSignal(); reads++;
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
      const after = await this.#live();
      const stale = !sameState(observed, after);
      const questions = results.flatMap(value => value.result.questions);
      const status = exhausted ? "budget_exhausted" : stale ? "stale_context" : questions.length ? "needs_input" : "proposed";
      const functional = results.find(value => value.role === "functional")?.result;
      checkMetadata.suggestedCheckCount = functional?.checks.length || 0;
      const operations = status === "proposed" ? functional?.operations || [] : [];
      const taskId = this.artifacts.put(projectId, "task", { goal, scope, constraints, basis: identity(observed), observedAfter: identity(after), contextRefs,
        ...(workflowRef?{workflowRef}:{}),
        results, turnRefs, status, ...checkMetadata, ...(stopReason ? { stopReason } : {}), operations,
        checks: postconditions || functional?.checks || [], allowedReads, allowedOperations, createdAt: new Date().toISOString() });
      return { taskId, status, ...checkMetadata, ...(stopReason ? { stopReason } : {}),
        summary: (exhausted ? `Specialist stopped at ${stopReason}; no executable proposal.` : results.at(-1)?.result.summary || "No specialist proposal.").slice(0, 1000),
        ...(workflowRef?{workflowRef}:{}),
        ...identity(observed), operationCount: operations.length, questions: questions.slice(0, 4).map(question => question.slice(0, 300)),
        questionsTruncated: questions.length > 4 || questions.some(question => question.length > 300),
        resultRefs: results.map(value => ({ role: value.role, artifactId: value.resultRef })),
        contextRef: observed.contextRef, readsUsed: reads, turnRefs };
    });
  }

  async #apply(args) {
    const { projectId, taskId, operationIndex, expectedStateVersion } = args;
    const taskRecord = this.artifacts.get(projectId, taskId);
    if (taskRecord.kind !== "task" || taskRecord.value.status !== "proposed") throw new Error("task is incomplete or not executable");
    const task = taskRecord.value;
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
    const nativeVerificationFailed = [value,value?.observed].some(native=>native?.verified === false || native?.targetRetained === false ||
      native?.contextPreserved === false || (native?.writeRequested === true && native?.nativeReturned === false));
    const nativeMetadata = nativeVerificationFailed ? {nativeVerificationFailed:true} : {};
    const status = observationError || nativeVerificationFailed ? "outcome_unknown" : value.pendingUserAction ? "pending_user_action"
      : value.playbackVerified === false ? "pending_postconditions"
      : checks.some(check => !check.matches) || value.saved === false || value.opened === false ? "postconditions_failed" : "applied";
    const receiptId = this.artifacts.put(projectId, "receipt", { taskId, operationIndex, status, ...checkMetadata, ...nativeMetadata, after, checks, resultRef, observationError });
    return { taskId, operationIndex, status, ...checkMetadata, ...nativeMetadata, receiptId, resultRef, ...(after ? identity(after) : {}), checks,
      verification: checks.length ? "declared_field_checks" : "operation_response_and_state_readback", audibleQualityVerified: false };
  }
}
