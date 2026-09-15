import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolService } from '../src/tool-service.mjs';

function fixture() {
  const track = { id: 'track-0', name: 'Bass Bus', type: 'midi', isGroup: false, isGrouped: false, groupTrackId: null };
  const device = { id: 'track-0:device-0', name: 'EQ Three', className: 'FilterEQ3', type: 'audio_effect' };
  const parameters = [{ id: 'parameter-0', name: 'Low Gain', originalName: 'GainLo', min: 0, max: 1,
    value: 0.8, displayValue: '0 dB', enabled: true, quantized: false, valueItems: [] }];
  const bridge = { async request(method, args) {
    if (method === 'get_track_state_snapshot') return { stateVersion: 7, trackId: track.id, track: structuredClone(track),
      mixer: { volume: { value: 0.85, min: 0, max: 1 }, pan: { value: 0, min: -1, max: 1 },
        mute: false, solo: false, sends: [{ id: 'return-0', name: 'Reverb', value: 0.2, min: 0, max: 1 }] },
      routing: { input: { type: { id: 'midi-all', name: 'All Ins' }, channel: { id: 'all', name: 'All Channels' } },
        output: { type: { id: 'master', name: 'Master' }, channel: null }, monitoring: { value: 1, name: 'Auto' } },
      devices: [{ ...structuredClone(device), parameters: structuredClone(parameters) }] };
    throw new Error(method);
  } };
  return { service: new ToolService({ bridge }), track };
}

test('track snapshot captures one consistent JSON state for mixer routing and ordered top-level devices', async () => {
  const { service } = fixture();
  const result = await service.call('capture_track_state_snapshot', { trackId: 'track-0' });
  const snapshot = JSON.parse(JSON.stringify(result.snapshot));
  assert.equal(snapshot.format, 'cavi-track-state-v1');
  assert.deepEqual(snapshot.track, { name: 'Bass Bus', type: 'midi', isGroup: false });
  assert.deepEqual(snapshot.mixer, { volume: 0.85, pan: 0, mute: false, solo: false,
    sends: [{ id: 'return-0', name: 'Reverb', value: 0.2 }] });
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
