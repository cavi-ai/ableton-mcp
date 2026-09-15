import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolService } from '../src/tool-service.mjs';

function fixture() {
  const device = { id: 'track-0:device-0', name: 'Renamed EQ', className: 'FilterEQ3' };
  const state = { stateVersion: 4, trackId: 'track-0', deviceId: device.id, parameters: [
    { id: 'p0', name: 'Low Gain', originalName: 'GainLo', min: 0, max: 1, value: 0.85, displayValue: '0 dB', enabled: true, quantized: false, valueItems: [] },
    { id: 'p1', name: 'Slope', originalName: 'Slope', min: 0, max: 1, value: 1, displayValue: '48', enabled: true, quantized: true, valueItems: ['24', '48'] }
  ] };
  const service = new ToolService({ bridge: { async request(method, args) {
    if (method === 'list_devices') return { stateVersion: state.stateVersion, trackId: state.trackId, devices: [device] };
    if (method === 'list_device_parameters') return structuredClone(state);
    if (method === 'set_device_parameters') {
      for (const change of args.changes) state.parameters.find(p => p.id === change.id).value = change.value;
      state.stateVersion++;
      return structuredClone(state);
    }
    throw new Error(method);
  } } });
  return { service, state, device, target: { trackId: state.trackId, deviceId: device.id } };
}

test('parameter snapshots survive JSON persistence and guarded recall restores captured values', async () => {
  const { service, state, target } = fixture();
  const { snapshot } = await service.call('capture_device_parameter_snapshot', target);
  assert.equal(snapshot.format, 'cavi-device-parameters-v1');
  assert.equal(snapshot.deviceClass, 'FilterEQ3');
  assert.deepEqual(snapshot.parameters.map(p => p.value), [0.85, 1]);
  state.parameters[0].value = 0.2;
  const args = { ...target, snapshot: JSON.parse(JSON.stringify(snapshot)), expectedStateVersion: 4 };
  const dry = await service.call('recall_device_parameter_snapshot', args);
  assert.equal(state.parameters[0].value, 0.2);
  await service.call('recall_device_parameter_snapshot', { ...args, dryRun: false,
    confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash });
  const after = await service.call('list_device_parameters', target);
  assert.deepEqual(after.parameters.map(p => p.value), [0.85, 1]);
});

test('recall refuses incompatible class, layout, ranges and disabled changed parameters', async () => {
  const { service, state, device, target } = fixture();
  const { snapshot } = await service.call('capture_device_parameter_snapshot', target);
  const recall = () => service.call('recall_device_parameter_snapshot', { ...target, snapshot, expectedStateVersion: 4 });
  device.className = 'Utility';
  await assert.rejects(recall, /class/);
  device.className = 'FilterEQ3';
  state.parameters[0].originalName = 'Other';
  await assert.rejects(recall, /layout/);
  state.parameters[0].originalName = 'GainLo';
  snapshot.parameters[0].value = 2;
  await assert.rejects(recall, /range/);
  snapshot.parameters[0].value = 0.85;
  state.parameters[0].value = 0.2;
  state.parameters[0].enabled = false;
  await assert.rejects(recall, /disabled/);
});
