const { spawnSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');

/**
 * Unused privacy keys injected by Electron's default Info.plist template that
 * OpenDesign thin shell does not require on macOS.
 */
const UNUSED_MAC_PLIST_KEYS = [
  'NSBluetoothAlwaysUsageDescription',
  'NSBluetoothPeripheralUsageDescription',
  'NSAudioCaptureUsageDescription',
];

/**
 * electron-builder afterPack hook:
 * - Strips unused Electron default privacy keys (Bluetooth, generic audio capture)
 *   from macOS Info.plist so privacy declarations stay minimal and accurate.
 * - Ensures NSAppTransportSecurity does not leave NSAllowsArbitraryLoads=true.
 */
module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const productFilename = context.packager.appInfo.productFilename;
  const plistPath = path.join(context.appOutDir, `${productFilename}.app`, 'Contents', 'Info.plist');
  if (!existsSync(plistPath)) return;

  const plistBuddy = '/usr/libexec/PlistBuddy';
  if (!existsSync(plistBuddy)) return;

  for (const key of UNUSED_MAC_PLIST_KEYS) {
    spawnSync(plistBuddy, ['-c', `Delete :${key}`, plistPath], { stdio: 'ignore' });
  }

  // Enforce strict ATS: disallow arbitrary cleartext HTTP loads while keeping local loopback.
  spawnSync(plistBuddy, ['-c', 'Delete :NSAppTransportSecurity:NSAllowsArbitraryLoads', plistPath], {
    stdio: 'ignore',
  });
  spawnSync(
    plistBuddy,
    ['-c', 'Add :NSAppTransportSecurity:NSAllowsArbitraryLoads bool false', plistPath],
    { stdio: 'ignore' },
  );
  spawnSync(
    plistBuddy,
    ['-c', 'Set :NSAppTransportSecurity:NSAllowsLocalNetworking true', plistPath],
    { stdio: 'ignore' },
  );
};
