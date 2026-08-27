'use strict';

/**
 * Which graphics adapter did Chromium actually pick, and did it fall back to
 * software?
 *
 * getGPUFeatureStatus() says WHETHER hardware is in use; it never says WHY not.
 * getGPUInfo('complete') carries the answer: the active adapter, the GL renderer
 * string (SwiftShader means software), and the driver Chromium saw.
 *
 * This matters because a machine can have a fast GPU and still composite in
 * software - a virtual display adapter winning the adapter selection, a remote
 * session with no device access, or a blocklist entry will all do it.
 *
 * Usage: npx electron scripts/diagnose-gpu.js
 * Dev tooling. Ships with nothing.
 */

const { app } = require('electron');

app.whenReady().then(async () => {
  const status = app.getGPUFeatureStatus();
  console.log('=== feature status ===');
  for (const [k, v] of Object.entries(status)) console.log('  ', k.padEnd(36), v);

  let info;
  try {
    info = await app.getGPUInfo('complete');
  } catch (e) {
    console.log('getGPUInfo failed:', e.message);
    app.quit();
    return;
  }

  const aux = info.auxAttributes || {};
  console.log('');
  console.log('=== what Chromium is actually rendering with ===');
  console.log('   GL renderer     :', aux.glRenderer || '(none)');
  console.log('   GL vendor       :', aux.glVendor || '(none)');
  console.log('   GL version      :', aux.glVersion || '(none)');
  console.log('   software render :', aux.softwareRendering);
  console.log('   GPU process crashes:', aux.processCrashCount);
  console.log('   sandboxed       :', aux.sandboxed);

  console.log('');
  console.log('=== adapters Chromium can see ===');
  for (const d of info.gpuDevice || []) {
    console.log(`   vendor 0x${(d.vendorId || 0).toString(16)} device 0x${(d.deviceId || 0).toString(16)}`,
      d.active ? '<-- ACTIVE' : '', d.deviceString || '', d.driverVersion || '');
  }

  // Video acceleration is reported separately from the feature flags.
  const vd = info.videoDecoding || aux.videoDecodeAcceleratorSupportedProfile;
  console.log('');
  console.log('=== hardware video decode profiles offered ===');
  const profiles = aux.videoDecodeAcceleratorSupportedProfile || vd || [];
  if (!profiles.length) console.log('   NONE - every codec will be decoded on the CPU');
  else for (const p of profiles) console.log('  ', JSON.stringify(p));

  app.quit();
}).catch((e) => { console.error(e); app.quit(); });
