export async function readTakeLaneContext(bridge,args) {
  if (typeof args.trackId !== 'string' || !/^track-(?:0|[1-9][0-9]*)$/.test(args.trackId) ||
      args.takeClipId !== undefined && (typeof args.takeClipId !== 'string' || !args.takeClipId.startsWith(args.trackId + ':take-lane-') ||
      !/^:take-lane-(?:0|[1-9][0-9]*):clip-(?:0|[1-9][0-9]*)$/.test(args.takeClipId.slice(args.trackId.length)))) {
    throw Error('canonical ordinary track and take clip required');
  }
  const before = await bridge.request('get_take_lane_context',{trackId:args.trackId,...(args.takeClipId !== undefined ? {takeClipId:args.takeClipId} : {})});
  if (!Number.isInteger(before.stateVersion) || before.trackId !== args.trackId || typeof before.identityToken !== 'string' || !before.identityToken ||
      typeof before.supported !== 'boolean' || before.takePromotionSupported !== false || !Array.isArray(before.lanes) || before.lanes.length > 128 || !Array.isArray(before.arrangement) ||
      before.arrangement.length > 4096 || !before.track || !before.recording ||
      args.takeClipId !== undefined && (before.takeClipId !== args.takeClipId || before.selected?.id !== args.takeClipId)) {
    throw Error('updated bridge take lane context required');
  }
  return before;
}
