"""Read rack controls and resolve mappings by native parameter identity."""

try:
    from .bridge import _device, _device_owner, _device_record, _parameter_record, _transport_recording_context
except ImportError:
    from bridge import _device, _device_owner, _device_record, _parameter_record, _transport_recording_context


def context(song, params, state_version):
    owner_id, device_id = params['trackId'], params['deviceId']
    _, _, rack = _device(song, owner_id, device_id)
    _, owner = _device_owner(song, owner_id)
    fields = ('visible_macro_count', 'variation_count', 'selected_variation_index', 'has_macro_mappings')
    if not rack.can_have_chains or not all(hasattr(rack, field) for field in fields):
        raise ValueError('device does not expose native rack macros')
    count = int(rack.visible_macro_count)
    if count < 0 or count > 16:
        raise ValueError('rack macro count is outside the supported limit')
    parameters = tuple(rack.parameters)
    layout_known = len(parameters) > count and all(
        parameters[index + 1].original_name == 'Macro %s' % (index + 1) for index in range(count))
    macros = [{'macroIndex': index, 'parameter': _parameter_record(parameters[index + 1], index + 1, True)}
              for index in range(count)] if layout_known else []
    targets = []
    visited = [0]

    def visit(device, native_id, depth):
        visited[0] += 1
        if depth > 16 or visited[0] > 512:
            raise ValueError('rack hierarchy exceeds the supported limit')
        for index, parameter in enumerate(device.parameters):
            targets.append((parameter, native_id, index))
            if len(targets) > 16384:
                raise ValueError('rack parameter count exceeds the supported limit')
        if device.can_have_chains:
            visit_chains(device, native_id, depth)

    def visit_chains(device, native_id, depth):
        for kind, chains in [('chain', device.chains), ('return-chain', getattr(device, 'return_chains', ()) )]:
            for chain_index, chain in enumerate(chains):
                for child_index, child in enumerate(chain.devices):
                    visit(child, '%s/%s-%s/device-%s' % (native_id, kind, chain_index, child_index), depth + 1)

    # Paths are display text, not parameter IDs. Search ordinary and rack Return chains.
    visit_chains(rack, device_id, 0)
    available = hasattr(rack, 'macro_mappings')
    mappings = None
    if available:
        native_mappings = tuple(rack.macro_mappings)
        if len(native_mappings) > 1024:
            raise ValueError('rack mapping count exceeds the supported limit')
        mappings = []
        for mapping in native_mappings:
            matches = [(native_id, index) for parameter, native_id, index in targets
                       if parameter == mapping.parameter]
            target = None
            if len(matches) == 1:
                target = {'deviceId': matches[0][0],
                          'parameter': _parameter_record(mapping.parameter, matches[0][1], True)}
            mappings.append({'macroIndex': int(mapping.index), 'targetPath': str(mapping.path),
                             'min': float(mapping.mapping_min), 'max': float(mapping.mapping_max),
                             'minDisplay': str(mapping.mapping_min_string),
                             'maxDisplay': str(mapping.mapping_max_string),
                             'resolution': 'resolved' if target else ('ambiguous' if matches else 'unresolved'),
                             'target': target})
    return {'stateVersion': state_version, 'trackId': owner_id, 'deviceId': device_id,
            'trackName': str(owner.name), 'trackFrozen': bool(getattr(owner, 'is_frozen', False)),
            'device': _device_record(rack, device_id), 'macroLayoutKnown': layout_known,
            'macros': macros, 'hasMappings': bool(rack.has_macro_mappings),
            'mappingTargetsAvailable': available, 'mappings': mappings,
            'operations': {'mapTargets': available and callable(getattr(rack, 'macro_map', None)),
                           'storeVariation': bool(rack.has_macro_mappings) and callable(getattr(rack, 'store_variation', None)),
                           'recallVariation': bool(rack.has_macro_mappings) and callable(getattr(rack, 'recall_selected_variation', None))},
            'variations': {'count': int(rack.variation_count),
                           'selectedIndex': int(rack.selected_variation_index), 'contentsAvailable': False},
            'recording': _transport_recording_context(song, state_version)}
