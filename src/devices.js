const { v4: uuidv4 } = require('uuid');

const devices = new Map(); // deviceId -> device info
const provisioningCodes = new Map(); // code -> deviceId

function createDevice(buildingId, name) {
  const deviceId = uuidv4();
  const code = generateProvisioningCode();

  devices.set(deviceId, {
    deviceId,
    buildingId,
    name,
    status: 'pending', // pending | active | revoked
    createdAt: new Date().toISOString(),
  });

  provisioningCodes.set(code, deviceId);

  return { deviceId, code };
}

function generateProvisioningCode() {
  // 6-digit numeric code, easy to type on device
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function validateProvisioningCode(code) {
  const deviceId = provisioningCodes.get(code);
  if (!deviceId) return null;

  const device = devices.get(deviceId);
  if (!device || device.status !== 'pending') return null;

  // Mark as active and remove the code
  device.status = 'active';
  provisioningCodes.delete(code);

  return device;
}

function getDevice(deviceId) {
  return devices.get(deviceId);
}

function revokeDevice(deviceId) {
  const device = devices.get(deviceId);
  if (device) device.status = 'revoked';
}

function listDevices() {
  return Array.from(devices.values());
}

module.exports = {
  createDevice,
  validateProvisioningCode,
  getDevice,
  revokeDevice,
  listDevices,
};
