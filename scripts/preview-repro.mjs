/**
 * Launch the preview server replaying a saved state — a wrapper so the
 * Browser pane's launch.json (which cannot set env vars) can still drive a
 * PREVIEW_STATE session. Point REPRO_STATE at a state file, or leave it to
 * default to the scratchpad copy used during a live investigation.
 */
process.env.PREVIEW_STATE = process.env.REPRO_STATE
  || 'C:/Users/Audrey/AppData/Local/Temp/claude/C--Users-Audrey-Documents-My-Work-Dev-Work-Claude-Work/f427906c-b94a-4a93-9161-b94d6081b958/scratchpad/repro-state.json';

await import('./preview-server.js');
