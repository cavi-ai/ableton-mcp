import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolService } from '../src/tool-service.mjs';
import { SnapshotLibrary } from '../src/snapshot-library.mjs';
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
  assert.deepEqual(snapshot.track, { name: 'Bass Bus', type: 'midi', isGroup: false });
  assert.deepEqual(snapshot.mixer, { volume: 0.85, pan: 0, mute: false, solo: false,
    sends: [{ id: 'send-0', name: 'Reverb', value: 0.2 }] });
  assert.deepEqual(snapshot.routing, { inputTypeId: 'midi-all', inputChannelId: 'all',
    outputTypeId: 'master', outputChannelId: null, monitoring: 1 });
  assert.deepEqual(snapshot.devices, [{ name: 'EQ Three', className: 'FilterEQ3', type: 'audio_effect', parameters: [{
    originalName: 'GainLo', min: 0, max: 1, quantized: false, valueItems: [], value: 0.8
  }] }]);
  assert.equal(result.stateVersion, 7);
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
