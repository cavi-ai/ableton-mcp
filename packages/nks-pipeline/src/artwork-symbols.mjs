const paths = {
  "low-orbit": '<ellipse cx="64" cy="64" rx="38" ry="22"/><circle cx="64" cy="64" r="8"/><path d="M18 82 Q64 104 110 82"/>',
  "rising-spear": '<path d="M64 108 L64 22 M44 46 L64 22 L84 46"/><path d="M36 94 L64 66 L92 94"/>',
  "soft-horizon": '<path d="M18 72 Q40 48 64 72 Q88 96 110 72"/><path d="M24 90 Q64 68 104 90"/>',
  "radiant-point": '<path d="M64 18 L74 54 L110 64 L74 74 L64 110 L54 74 L18 64 L54 54 Z"/>',
  "split-steps": '<path d="M20 94 H46 V70 H72 V46 H108"/><path d="M20 108 H108"/>',
  "twin-bow": '<path d="M34 20 Q72 64 34 108 M94 20 Q56 64 94 108"/><path d="M24 64 H104"/>',
  "flared-bell": '<path d="M48 24 H80 L84 74 Q92 84 108 96 H20 Q36 84 44 74 Z"/><path d="M36 104 H92"/>',
  "impact-ring": '<circle cx="64" cy="64" r="36"/><circle cx="64" cy="64" r="16"/><path d="M64 12 V34 M64 94 V116 M12 64 H34 M94 64 H116"/>',
  "three-strikes": '<path d="M34 24 L50 104 M64 20 V108 M94 24 L78 104"/>',
  "ascending-nodes": '<path d="M20 98 L46 76 L68 54 L108 24"/><circle cx="20" cy="98" r="6"/><circle cx="46" cy="76" r="6"/><circle cx="68" cy="54" r="6"/><circle cx="108" cy="24" r="6"/>',
  "pulse-path": '<path d="M14 70 H34 L44 42 L58 92 L72 52 L84 70 H114"/>',
  "broken-halo": '<path d="M38 28 A42 42 0 1 1 24 52 M90 28 L104 44"/><path d="M64 44 L78 64 L64 84 L50 64 Z"/>',
  "distant-eclipse": '<circle cx="64" cy="64" r="38"/><path d="M34 88 A38 38 0 0 0 94 40 A30 30 0 0 1 34 88"/>',
  "breath-wave": '<path d="M16 68 Q30 38 44 68 T72 68 T100 68 T116 68"/><path d="M28 88 Q64 106 100 88"/>',
  "quiet-constellation": '<circle cx="30" cy="80" r="4"/><circle cx="54" cy="42" r="4"/><circle cx="82" cy="58" r="4"/><circle cx="102" cy="28" r="4"/><path d="M30 80 L54 42 L82 58 L102 28"/>'
};

export function symbolSvg(symbol, accent = "#ffffff") {
  const body = paths[symbol];
  if (!body) throw new Error(`unknown artwork symbol ${symbol}`);
  if (!/^#[0-9a-f]{6}$/i.test(accent)) throw new Error(`invalid artwork accent ${accent}`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><g fill="none" stroke="${accent}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" opacity="0.72">${body}</g></svg>`;
}
