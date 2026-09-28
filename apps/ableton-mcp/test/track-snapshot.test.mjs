import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolService } from '../src/tool-service.mjs';
import { SnapshotLibrary } from '../src/snapshot-library.mjs';
import { validateToolArguments } from '../src/tool-validation.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

function fixture(snapshotLibrary) {
  const track = { id: 'track-0', name: 'Bass Bus', type: 'midi', isGroup: false, isGrouped: false, groupTrackId: null };
  const device = { id: 'track-0:device-0', name: 'EQ Three', className: 'FilterEQ3', type: 'audio_effect' };
  const parameters = [{ id: 'parameter-0', name: 'Low Gain', originalName: 'GainLo', min: 0, max: 1,
    value: 0.8, displayValue: '0 dB', enabled: true, quantized: false, valueItems: [] }];
  const native = { stateVersion: 7, trackId: track.id, track,
      mixer: { volume: { value: 0.85, min: 0, max: 1 }, pan: { value: 0, min: -1, max: 1 },
        mute: false, solo: false, sends: [{ id: 'send-0', returnTrackId: 'return-0', name: 'Reverb', value: 0.2, min: 0, max: 1 }] },
      routing: { input: { type: { id: 'midi-all', name: 'All Ins' }, channel: { id: 'all', name: 'All Channels' }, availableTypes: [{ id: 'midi-all', name: 'All Ins' }], availableChannels: [{ id: 'all', name: 'All Channels' }] },
        output: { type: { id: 'master', name: 'Master' }, channel: null, availableTypes: [{ id: 'master', name: 'Master' }], availableChannels: [] }, monitoring: { value: 1, name: 'Auto', choices: [{ value: 1, name: 'auto' }] } },
      devices: [{ ...device, parameters }] };
  const bridge = { async request(method, args) {
    if (method === 'get_track_state_snapshot') return structuredClone(native);
    if (method === 'set_track_state_snapshot') {
      native.track.name = args.target.track.name;
      Object.assign(native.mixer, { volume: { ...native.mixer.volume, value: args.target.mixer.volume },
        pan: { ...native.mixer.pan, value: args.target.mixer.pan }, mute: args.target.mixer.mute, solo: args.target.mixer.solo });
      native.mixer.sends.forEach((send, index) => { send.value = args.target.mixer.sends[index].value; });
      native.devices.forEach((item, deviceIndex) => item.parameters.forEach((parameter, parameterIndex) => {
        parameter.value = args.target.devices[deviceIndex].parameters[parameterIndex].value;
      }));
      native.stateVersion++;
      return structuredClone(native);
    }
    throw new Error(method);
  } };
  return { service: new ToolService({ bridge, snapshotLibrary }), native };
}

test('saved track capture is readable as JSON for guarded recall', async () => {
  const directory = await mkdtemp(`${tmpdir()}/cavi-track-library-test-`);
  try {
    const { service } = fixture(new SnapshotLibrary({ directory }));
    const saved = await service.call('save_track_state_snapshot', { trackId: 'track-0', name: 'bass-chain' });
    assert.equal(saved.stateVersion, 7);
    assert.equal(saved.name, 'bass-chain');
    const loaded = await service.call('load_track_state_snapshot', { name: 'bass-chain' });
    assert.equal(loaded.snapshot.track.name, 'Bass Bus');
    assert.equal(loaded.snapshot.devices[0].className, 'FilterEQ3');
    await assert.rejects(() => service.call('save_track_state_snapshot', { trackId: 'track-0', name: 'bass-chain' }), /already exists/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('track snapshot captures one consistent JSON state for mixer routing and ordered top-level devices', async () => {
  const { service } = fixture();
  const result = await service.call('capture_track_state_snapshot', { trackId: 'track-0' });
  const snapshot = JSON.parse(JSON.stringify(result.snapshot));
  assert.equal(snapshot.format, 'cavi-track-state-v1');
  assert.deepEqual(snapshot.track, { name: 'Bass Bus', type: 'midi', isGroup: false,
    isGrouped: false, groupTrackId: null });
  assert.deepEqual(snapshot.mixer, { volume: 0.85, pan: 0, mute: false, solo: false,
    sends: [{ id: 'send-0', name: 'Reverb', value: 0.2 }] });
  assert.deepEqual(snapshot.routing, { inputTypeId: 'midi-all', inputChannelId: 'all',
    outputTypeId: 'master', outputChannelId: null, monitoring: 1 });
  assert.deepEqual(snapshot.devices, [{ name: 'EQ Three', className: 'FilterEQ3', type: 'audio_effect', parameters: [{
    originalName: 'GainLo', min: 0, max: 1, quantized: false, valueItems: [], value: 0.8
  }] }]);
  assert.equal(result.stateVersion, 7);
});

test('group-system capture saves the parent, nested group and descendant tracks in Live order', async () => {
  const directory = await mkdtemp(`${tmpdir()}/cavi-group-system-test-`);
  const tracks = [
    { id: 'track-0', name: 'Bass Bus', type: 'group', isGroup: true, isGrouped: false, groupTrackId: null },
    { id: 'track-1', name: 'Sub Bus', type: 'group', isGroup: true, isGrouped: true, groupTrackId: 'track-0' },
    { id: 'track-2', name: 'Sub Bass', type: 'midi', isGroup: false, isGrouped: true, groupTrackId: 'track-1' },
    { id: 'track-3', name: 'Top Bass', type: 'midi', isGroup: false, isGrouped: true, groupTrackId: 'track-0' },
    { id: 'track-4', name: 'Unrelated', type: 'audio', isGroup: false, isGrouped: false, groupTrackId: null },
  ];
  const bridge = { async request(method, args) {
    if (method === 'list_tracks') return { stateVersion: 7, tracks: structuredClone(tracks) };
    if (method !== 'get_track_state_snapshot') throw new Error(method);
    const track = tracks.find(item => item.id === args.trackId);
    return { stateVersion: 7, trackId: track.id, track: structuredClone(track),
      mixer: { volume: { value: 0.8 }, pan: { value: 0 }, mute: false, solo: false, sends: [] },
      routing: { input: { type: null, channel: null }, output: { type: null, channel: null }, monitoring: null },
      devices: [] };
  } };
  const groupSystemLibrary = new SnapshotLibrary({ directory, formats: ['cavi-group-system-v1'] });
  const service = new ToolService({ bridge, groupSystemLibrary });
  try {
    const capture = await service.call('capture_group_system_snapshot', { busTrackId: 'track-0' });
    assert.equal(capture.snapshot.format, 'cavi-group-system-v1');
    assert.deepEqual(capture.snapshot.tracks.map(item => item.sourceTrackId), ['track-0', 'track-1', 'track-2', 'track-3']);
    assert.deepEqual(capture.snapshot.tracks.map(item => item.snapshot.track.groupTrackId),
      [null, 'track-0', 'track-1', 'track-0']);
    const saved = await service.call('save_group_system_snapshot', { busTrackId: 'track-0', name: 'layered-bass' });
    assert.equal(saved.name, 'layered-bass');
    const loaded = await service.call('load_group_system_snapshot', { name: 'layered-bass' });
    assert.deepEqual(loaded.snapshot, capture.snapshot);
    assert.deepEqual((await service.call('list_saved_snapshots', { kind: 'group-system' })).names, ['layered-bass']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('group-system capture rejects a changed child snapshot instead of saving mixed Live states', async () => {
  const tracks = [
    { id: 'track-0', name: 'Bus', type: 'group', isGroup: true, isGrouped: false, groupTrackId: null },
    { id: 'track-1', name: 'Bass', type: 'midi', isGroup: false, isGrouped: true, groupTrackId: 'track-0' },
  ];
  const service = new ToolService({ bridge: { async request(method, args) {
    if (method === 'list_tracks') return { stateVersion: 7, tracks };
    if (method === 'get_track_state_snapshot') return {
      stateVersion: args.trackId === 'track-1' ? 8 : 7, trackId: args.trackId,
      track: tracks.find(track => track.id === args.trackId),
      mixer: { volume: { value: 0.8 }, pan: { value: 0 }, mute: false, solo: false, sends: [] },
      routing: { input: { type: null, channel: null }, output: { type: null, channel: null }, monitoring: null },
      devices: [],
    };
    throw new Error(method);
  } } });
  await assert.rejects(() => service.call('capture_group_system_snapshot', { busTrackId: 'track-0' }),
    /state.*changed/i);
});

test('group-system capture rejects a same-version Live UI change during capture', async () => {
  const tracks = [
    { id: 'track-0', name: 'Bus', type: 'group', isGroup: true, isGrouped: false, groupTrackId: null },
    { id: 'track-1', name: 'Bass', type: 'midi', isGroup: false, isGrouped: true, groupTrackId: 'track-0' },
  ];
  let childReads = 0;
  const service = new ToolService({ bridge: { async request(method, args) {
    if (method === 'list_tracks') return { stateVersion: 7, tracks: structuredClone(tracks) };
    if (method !== 'get_track_state_snapshot') throw new Error(method);
    const track = tracks.find(item => item.id === args.trackId);
    if (args.trackId === 'track-1') childReads++;
    return { stateVersion: 7, trackId: track.id, track: structuredClone(track),
      mixer: { volume: { value: childReads > 1 ? 0.6 : 0.8 }, pan: { value: 0 },
        mute: false, solo: false, sends: [] },
      routing: { input: { type: null, channel: null }, output: { type: null, channel: null }, monitoring: null },
      devices: [] };
  } } });
  await assert.rejects(() => service.call('capture_group_system_snapshot', { busTrackId: 'track-0' }),
    /state.*changed/i);
});

test('group-system recall plan maps a saved nested hierarchy to compatible existing tracks without writing Live', async () => {
  const directory = await mkdtemp(`${tmpdir()}/cavi-group-plan-test-`);
  const source = [
    { id: 'track-0', name: 'Bass Bus', type: 'group', isGroup: true, isGrouped: false, groupTrackId: null },
    { id: 'track-1', name: 'Sub Bass', type: 'midi', isGroup: false, isGrouped: true, groupTrackId: 'track-0' },
  ];
  const target = [
    { id: 'track-5', name: 'Target Bus', type: 'group', isGroup: true, isGrouped: false, groupTrackId: null },
    { id: 'track-6', name: 'Target Bass', type: 'midi', isGroup: false, isGrouped: true, groupTrackId: 'track-5' },
  ];
  const groupSystemLibrary = new SnapshotLibrary({ directory, formats: ['cavi-group-system-v1'] });
  await groupSystemLibrary.save('bass', { format: 'cavi-group-system-v1', tracks: source.map(track => ({
    sourceTrackId: track.id, snapshot: { format: 'cavi-track-state-v1',
      track: { name: track.name, type: track.type, isGroup: track.isGroup,
        isGrouped: track.isGrouped, groupTrackId: track.groupTrackId },
      mixer: { volume: 0.8, pan: 0, mute: false, solo: false, sends: [] },
      routing: { inputTypeId: null, inputChannelId: null, outputTypeId: null,
        outputChannelId: null, monitoring: null }, devices: [] } })) });
  let driftOnSecondChildRead = false;
  let childReads = 0;
  const bridge = { async request(method, args) {
    if (method === 'list_tracks') return { stateVersion: 7, tracks: structuredClone(target) };
    if (method !== 'get_track_state_snapshot') throw new Error(`unexpected write or request: ${method}`);
    const track = target.find(item => item.id === args.trackId);
    if (args.trackId === 'track-6') childReads++;
    return { stateVersion: 7, trackId: track.id, track: structuredClone(track),
      mixer: { volume: { value: driftOnSecondChildRead && childReads > 1 ? 0.6 : 0.7, min: 0, max: 1 },
        pan: { value: 0, min: -1, max: 1 },
        mute: false, solo: false, sends: [] },
      routing: { input: { type: null, channel: null, availableTypes: [], availableChannels: [] },
        output: { type: null, channel: null, availableTypes: [], availableChannels: [] }, monitoring: null },
      devices: [] };
  } };
  const service = new ToolService({ bridge, groupSystemLibrary });
  try {
    const mapping = [{ sourceTrackId: 'track-0', targetTrackId: 'track-5' },
      { sourceTrackId: 'track-1', targetTrackId: 'track-6' }];
    const result = await service.call('plan_group_system_recall', { name: 'bass', busTrackId: 'track-5', mapping });
    assert.equal(result.dryRun, true);
    assert.deepEqual(result.tracks.map(item => [item.sourceTrackId, item.targetTrackId, item.status]),
      [['track-0', 'track-5', 'compatible'], ['track-1', 'track-6', 'compatible']]);
    assert.equal(result.tracks[1].target.track.groupTrackId, 'track-5');
    await assert.rejects(() => service.call('plan_group_system_recall', { name: 'bass', busTrackId: 'track-5',
      mapping: [{ sourceTrackId: 'track-0', targetTrackId: 'track-5' },
        { sourceTrackId: 'track-1', targetTrackId: 'track-5' }] }), /mapping|topology/i);
    target.push({ id: 'track-7', name: 'Extra Child', type: 'midi', isGroup: false,
      isGrouped: true, groupTrackId: 'track-5' });
    await assert.rejects(() => service.call('plan_group_system_recall', { name: 'bass', busTrackId: 'track-5', mapping }),
      /topology/i);
    target.pop();
    driftOnSecondChildRead = true;
    childReads = 0;
    await assert.rejects(() => service.call('plan_group_system_recall', { name: 'bass', busTrackId: 'track-5', mapping }),
      /state.*changed/i);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('track snapshot saves nested rack state and plans compatible nested recall', async () => {
  const directory = await mkdtemp(`${tmpdir()}/cavi-nested-track-test-`);
  try {
    const { service, native } = fixture(new SnapshotLibrary({ directory }));
    native.devices[0].name = 'Audio Effect Rack';
    native.devices[0].className = 'AudioEffectGroupDevice';
    native.devices[0].chains = [{ name: 'Parallel', devices: [{
      id: 'track-0:device-0/chain-0/device-0', name: 'EQ Three', className: 'FilterEQ3',
      type: 'audio_effect', parameters: structuredClone(native.devices[0].parameters),
    }] }];
    native.devices[0].returnChains = [];
    await service.call('save_track_state_snapshot', { trackId: 'track-0', name: 'nested-rack' });
    const loaded = await service.call('load_track_state_snapshot', { name: 'nested-rack' });
    assert.equal(loaded.snapshot.format, 'cavi-track-state-v2');
    assert.equal(loaded.snapshot.devices[0].chains[0].devices[0].name, 'EQ Three');
    validateToolArguments('recall_track_state_snapshot', {
      trackId: 'track-0', expectedStateVersion: 7, snapshot: loaded.snapshot,
    });
    native.devices[0].chains[0].devices[0].parameters[0].value = 0.2;
    const dry = await service.call('recall_track_state_snapshot', {
      trackId: 'track-0', expectedStateVersion: 7, snapshot: loaded.snapshot,
    });
    assert.equal(dry.plan.target.devices[0].chains[0].devices[0].parameters[0].value, 0.8);
    native.devices[0].chains[0].devices[0].className = 'Compressor2';
    await assert.rejects(() => service.call('recall_track_state_snapshot', {
      trackId: 'track-0', expectedStateVersion: 7, snapshot: loaded.snapshot,
    }), /topology mismatch/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('track snapshot saves rack mixer and Drum Rack note routing for guarded recall', async () => {
  const directory = await mkdtemp(`${tmpdir()}/cavi-controlled-track-test-`);
  try {
    const { service, native } = fixture(new SnapshotLibrary({ directory }));
    native.devices[0].className = 'InstrumentGroupDevice';
    native.devices[0].name = 'Drum Rack';
    native.devices[0].chains = [{ name: 'Kick', devices: [],
      mixer: { volume: { value: 0.4, min: 0, max: 1, enabled: true }, pan: { value: 0, min: -1, max: 1, enabled: true },
        sends: [{ index: 0, value: 0.2, min: 0, max: 1, enabled: true }], mute: false, solo: false },
      noteRouting: { inputNote: 36, outputNote: 36 } }];
    native.devices[0].returnChains = [];
    await service.call('save_track_state_snapshot', { trackId: 'track-0', name: 'kick-rack' });
    const loaded = await service.call('load_track_state_snapshot', { name: 'kick-rack' });
    assert.equal(loaded.snapshot.format, 'cavi-track-state-v3');
    assert.equal(loaded.snapshot.devices[0].chains[0].mixer.volume, 0.4);
    assert.equal(loaded.snapshot.devices[0].chains[0].noteRouting.inputNote, 36);
    validateToolArguments('recall_track_state_snapshot', { trackId: 'track-0', expectedStateVersion: 7,
      snapshot: loaded.snapshot });
    native.devices[0].chains[0].mixer.volume.value = 0.2;
    const dry = await service.call('recall_track_state_snapshot', { trackId: 'track-0', expectedStateVersion: 7,
      snapshot: loaded.snapshot });
    assert.equal(dry.plan.target.devices[0].chains[0].mixer.volume, 0.4);
    const invalid = structuredClone(loaded.snapshot);
    invalid.devices[0].chains[0].noteRouting.inputNote = 128;
    await assert.rejects(() => service.call('recall_track_state_snapshot', { trackId: 'track-0',
      expectedStateVersion: 7, snapshot: invalid }), /note routing outside native range/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('track snapshot captures populated Drum Rack pad state for guarded recall', async () => {
  const { service, native } = fixture();
  native.devices[0].name = 'Drum Rack';
  native.devices[0].className = 'InstrumentGroupDevice';
  native.devices[0].chains = [{ name: 'Kick', devices: [],
    mixer: { volume: null, pan: null, sends: [], mute: null, solo: null },
    noteRouting: { inputNote: null, outputNote: null } }];
  native.devices[0].returnChains = [];
  native.devices[0].drumPads = [{ note: 36, mute: true, solo: false }];
  const captured = await service.call('capture_track_state_snapshot', { trackId: 'track-0' });
  assert.equal(captured.snapshot.format, 'cavi-track-state-v4');
  assert.deepEqual(captured.snapshot.devices[0].drumPads, [{ note: 36, mute: true, solo: false }]);
  validateToolArguments('recall_track_state_snapshot', { trackId: 'track-0', expectedStateVersion: 7,
    snapshot: captured.snapshot });
  native.devices[0].drumPads[0].mute = false;
  const dry = await service.call('recall_track_state_snapshot', { trackId: 'track-0', expectedStateVersion: 7,
    snapshot: captured.snapshot });
  assert.equal(dry.plan.target.devices[0].drumPads[0].mute, true);
});

test('track snapshot rejects a native callback response for another target', async () => {
  const { service } = fixture();
  const original = service.bridge.request.bind(service.bridge);
  service.bridge.request = async (method, args) => {
    const result = await original(method, args);
    result.trackId = 'track-1';
    return result;
  };
  await assert.rejects(() => service.call('capture_track_state_snapshot', { trackId: 'track-0' }), /target mismatch/);
});

test('guarded track recall restores captured values onto an exact compatible topology', async () => {
  const { service, native } = fixture();
  const { snapshot } = await service.call('capture_track_state_snapshot', { trackId: 'track-0' });
  native.track.name = 'Changed';
  native.mixer.volume.value = 0.4;
  native.mixer.sends[0].value = 0.7;
  native.devices[0].parameters[0].value = 0.1;
  const args = { trackId: 'track-0', expectedStateVersion: 7, snapshot: JSON.parse(JSON.stringify(snapshot)) };
  const dry = await service.call('recall_track_state_snapshot', args);
  assert.equal(native.mixer.volume.value, 0.4);
  const live = await service.call('recall_track_state_snapshot', { ...args, dryRun: false,
    confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash });
  assert.equal(live.observed.track.name, 'Bass Bus');
  assert.equal(live.observed.mixer.volume.value, 0.85);
  assert.equal(live.observed.mixer.sends[0].value, 0.2);
  assert.equal(live.observed.devices[0].parameters[0].value, 0.8);
});

test('track recall rejects incompatible type, device order, parameter layout and unavailable routing', async () => {
  const { service, native } = fixture();
  const { snapshot } = await service.call('capture_track_state_snapshot', { trackId: 'track-0' });
  const recall = () => service.call('recall_track_state_snapshot', { trackId: 'track-0', expectedStateVersion: 7, snapshot });
  snapshot.track.type = 'audio';
  await assert.rejects(recall, /track type/);
  snapshot.track.type = 'midi';
  snapshot.devices[0].className = 'Utility';
  await assert.rejects(recall, /device topology/);
  snapshot.devices[0].className = 'FilterEQ3';
  snapshot.devices[0].parameters[0].originalName = 'Other';
  await assert.rejects(recall, /parameter layout/);
  snapshot.devices[0].parameters[0].originalName = 'GainLo';
  snapshot.routing.outputTypeId = 'missing';
  await assert.rejects(recall, /routing/);
  native.stateVersion = 8;
  await assert.rejects(recall, /stateVersion/);
});

test('track recall rejects a plug-in device rename before issuing confirmation', async () => {
  const { service, native } = fixture();
  native.devices[0].name = 'Serum 2';
  native.devices[0].className = 'PluginDevice';
  native.devices[0].type = 'instrument';
  const { snapshot } = await service.call('capture_track_state_snapshot', { trackId: 'track-0' });
  snapshot.devices[0].name = 'Bass Texture';
  await assert.rejects(() => service.call('recall_track_state_snapshot', {
    trackId: 'track-0', expectedStateVersion: 7, snapshot
  }), /plug-in device name.*cannot be changed/);
});

test('track recall rejects a captured child after its parent group changes', async () => {
  const { service, native } = fixture();
  native.track.isGrouped = true;
  native.track.groupTrackId = 'track-1';
  const { snapshot } = await service.call('capture_track_state_snapshot', { trackId: 'track-0' });
  assert.equal(snapshot.track.groupTrackId, 'track-1');
  native.track.groupTrackId = 'track-2';
  await assert.rejects(() => service.call('recall_track_state_snapshot', {
    trackId: 'track-0', expectedStateVersion: 7, snapshot,
  }), /group membership/);
});

test('track recall defers dependent channel validation when the captured routing type differs', async () => {
  const { service, native } = fixture();
  native.routing.output.channel = { id: 'master-channel', name: 'Master Channel' };
  native.routing.output.availableChannels = [{ id: 'master-channel', name: 'Master Channel' }];
  const { snapshot } = await service.call('capture_track_state_snapshot', { trackId: 'track-0' });
  native.routing.output.type = { id: 'other', name: 'Other' };
  native.routing.output.availableTypes.push({ id: 'other', name: 'Other' });
  native.routing.output.channel = { id: 'other-channel', name: 'Other Channel' };
  native.routing.output.availableChannels = [{ id: 'other-channel', name: 'Other Channel' }];
  const dry = await service.call('recall_track_state_snapshot', { trackId: 'track-0', expectedStateVersion: 7, snapshot });
  assert.equal(dry.plan.target.routing.outputTypeId, 'master');
  assert.equal(dry.plan.target.routing.outputChannelId, 'master-channel');
});
