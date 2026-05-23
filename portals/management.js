const GOOGLE_CLIENT_ID = '1070504632843-t3ohfvsimcqsjspt31v8ajpvdffait6c.apps.googleusercontent.com';

let idToken = null;
let userEmail = null;
let userName = null;
let userPicture = null;
let assignedBuildings = [];
let selectedBuildingId = null;

window.addEventListener('DOMContentLoaded', () => {
  google.accounts.id.initialize({ client_id: GOOGLE_CLIENT_ID, callback: handleCredentialResponse });
  renderGoogleButton();

  document.addEventListener('click', handleClick);
  document.getElementById('buildingSelect').addEventListener('change', onBuildingChange);
  document.getElementById('editModal').addEventListener('click', (event) => {
    if (event.target === document.getElementById('editModal')) closeModal();
  });
  document.getElementById('assignModal').addEventListener('click', (event) => {
    if (event.target === document.getElementById('assignModal')) closeAssignModal();
  });
});

function handleClick(event) {
  const actionTarget = event.target.closest('[data-action]');
  if (!actionTarget) return;

  switch (actionTarget.dataset.action) {
    case 'sign-out': handleSignOut(); break;
    case 'show-section': showSection(actionTarget.dataset.sectionName, actionTarget); break;
    case 'load-apartments': loadApartments(); break;
    case 'create-apartment': createApartment(); break;
    case 'show-residents': showResidents(actionTarget.dataset.apartmentId, actionTarget.dataset.apartmentNumber); break;
    case 'edit-apartment': editApartment(actionTarget.dataset.apartmentId, actionTarget.dataset.apartmentNumber, actionTarget.dataset.apartmentName || ''); break;
    case 'delete-apartment': deleteApartment(actionTarget.dataset.apartmentId); break;
    case 'assign-resident': assignResident(actionTarget.dataset.apartmentId, actionTarget.dataset.apartmentNumber); break;
    case 'remove-resident': removeResident(actionTarget.dataset.apartmentId, actionTarget.dataset.userId, actionTarget.dataset.apartmentNumber); break;
    case 'load-devices': loadDevices(); break;
    case 'create-device': createDevice(); break;
    case 'revoke-device': revokeDevice(actionTarget.dataset.deviceId); break;
    case 'reprovision-device': reprovisionDevice(actionTarget.dataset.deviceId); break;
    case 'load-notifications': loadNotifications(); break;
    case 'create-notification': createNotification(); break;
    case 'delete-notification': deleteNotification(actionTarget.dataset.notificationId); break;
    case 'load-audit-logs': loadAuditLogs(); break;
    case 'save-building-settings': saveBuildingSettings(); break;
    case 'close-modal': closeModal(); break;
    case 'close-assign-modal': closeAssignModal(); break;
    case 'load-device-health': loadDeviceHealth(); break;
    case 'load-delivery-health': loadDeliveryHealth(); break;
    default: break;
  }
}

function handleCredentialResponse(response) {
  idToken = response.credential;
  const payload = JSON.parse(atob(idToken.split('.')[1]));
  userEmail = payload.email;
  userName = payload.name;
  userPicture = payload.picture;
  testManagementAccess();
}

async function testManagementAccess() {
  const buildings = await apiCall('/api/management/buildings');
  if (buildings === null) {
    showAccessDenied();
    return;
  }
  assignedBuildings = buildings;
  showManagementUI();
  populateBuildingSelect();
  if (assignedBuildings.length > 0) {
    selectedBuildingId = assignedBuildings[0].id;
    document.getElementById('buildingSelect').value = selectedBuildingId;
  }
  onBuildingChange();
}

function handleSignOut() {
  google.accounts.id.disableAutoSelect();
  idToken = null;
  userEmail = null;
  userName = null;
  userPicture = null;
  assignedBuildings = [];
  selectedBuildingId = null;
  showLoginPrompt();
}

function renderGoogleButton() {
  const authArea = document.getElementById('authArea');
  const buttonHost = document.createElement('div');
  buttonHost.id = 'googleSignInBtn';
  authArea.replaceChildren(buttonHost);
  google.accounts.id.renderButton(buttonHost, { theme: 'outline', size: 'large' });
}

function renderUserInfo(name, pictureUrl) {
  const authArea = document.getElementById('authArea');
  const wrapper = document.createElement('div');
  wrapper.className = 'user-info';
  if (pictureUrl) {
    const image = document.createElement('img');
    image.src = pictureUrl;
    image.alt = '';
    wrapper.appendChild(image);
  }
  const label = document.createElement('span');
  label.textContent = name;
  wrapper.appendChild(label);
  const button = document.createElement('button');
  button.id = 'signOutBtn';
  button.textContent = 'Sign Out';
  button.dataset.action = 'sign-out';
  wrapper.appendChild(button);
  authArea.replaceChildren(wrapper);
}

function showLoginPrompt() {
  document.getElementById('loginPrompt').style.display = '';
  document.getElementById('accessDenied').style.display = 'none';
  document.getElementById('mgmtContent').style.display = 'none';
  renderGoogleButton();
}

function showAccessDenied() {
  document.getElementById('loginPrompt').style.display = 'none';
  document.getElementById('accessDenied').style.display = '';
  document.getElementById('mgmtContent').style.display = 'none';
  renderUserInfo(userEmail || 'Unknown user');
}

function showManagementUI() {
  document.getElementById('loginPrompt').style.display = 'none';
  document.getElementById('accessDenied').style.display = 'none';
  document.getElementById('mgmtContent').style.display = '';
  renderUserInfo(userName || userEmail || 'Unknown user', userPicture || '');
}

function showSection(name, button) {
  document.querySelectorAll('.section').forEach((section) => section.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach((tab) => tab.classList.remove('active'));
  document.getElementById(`sec-${name}`).classList.add('active');
  if (button) button.classList.add('active');
}

function populateBuildingSelect() {
  const select = document.getElementById('buildingSelect');
  select.innerHTML = '<option value="">All Buildings</option>';
  for (const building of assignedBuildings) {
    const option = document.createElement('option');
    option.value = building.id;
    option.textContent = building.name;
    select.appendChild(option);
  }
}

function onBuildingChange() {
  selectedBuildingId = document.getElementById('buildingSelect').value || null;
  const hasBuilding = Boolean(selectedBuildingId);
  document.getElementById('aptCreateRow').style.display = hasBuilding ? 'flex' : 'none';
  document.getElementById('devCreateRow').style.display = hasBuilding ? 'flex' : 'none';
  document.getElementById('notifCreateRow').style.display = hasBuilding ? 'flex' : 'none';
  loadBuildingSettings();
  loadApartments();
  loadDevices();
  loadNotifications();
  loadAuditLogs();
  loadDeviceHealth();
  loadDeliveryHealth();
}

async function apiCall(url, options = {}) {
  const headers = { Authorization: `Bearer ${idToken}`, ...options.headers };
  try {
    const response = await fetch(url, { ...options, headers });
    if (response.status === 401) {
      handleSignOut();
      return null;
    }
    const data = await response.json();
    if (data.error) {
      alert(`Error: ${data.error}`);
      return null;
    }
    return data;
  } catch (err) {
    console.error('API error:', err);
    return null;
  }
}

function apiPost(url, body) {
  return apiCall(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

function apiPut(url, body) {
  return apiCall(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

function apiDelete(url) {
  return apiCall(url, { method: 'DELETE' });
}

function loadBuildingSettings() {
  const container = document.getElementById('buildingSettingsContent');
  if (!selectedBuildingId) {
    container.innerHTML = '<div class="empty-state">Select a building to view settings.</div>';
    return;
  }
  const building = assignedBuildings.find((entry) => entry.id === selectedBuildingId);
  if (!building) {
    container.innerHTML = '<div class="empty-state">Building not found.</div>';
    return;
  }
  container.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
      <div><strong>Name:</strong> ${esc(building.name)}</div>
      <div><strong>Address:</strong> ${esc(building.address)}</div>
    </div>
    <hr style="margin:16px 0;border:none;border-top:1px solid #dfe6e9;" />
    <div class="form-row">
      <div class="form-group"><label>Door Opening Time (s)</label><input type="number" id="bs-doorTime" value="${building.door_opening_time}" /></div>
      <div class="form-group"><label>No Answer Timeout (s)</label><input type="number" id="bs-timeout" value="${building.no_answer_timeout}" /></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label>Language</label><input id="bs-lang" value="${esc(building.language)}" /></div>
      <div class="form-group"><label>Volume (0-100)</label><input type="number" id="bs-vol" value="${building.volume}" min="0" max="100" /></div>
      <div class="form-group"><label>Brightness (0-100)</label><input type="number" id="bs-bright" value="${building.brightness}" min="0" max="100" /></div>
    </div>
    <button class="btn btn-primary" data-action="save-building-settings">Save Settings</button>
  `;
}

async function saveBuildingSettings() {
  if (!selectedBuildingId) return;
  const result = await apiPut(`/api/management/buildings/${selectedBuildingId}`, {
    door_opening_time: parseInt(document.getElementById('bs-doorTime').value, 10),
    no_answer_timeout: parseInt(document.getElementById('bs-timeout').value, 10),
    language: document.getElementById('bs-lang').value,
    volume: parseInt(document.getElementById('bs-vol').value, 10),
    brightness: parseInt(document.getElementById('bs-bright').value, 10),
  });
  if (result) {
    const index = assignedBuildings.findIndex((entry) => entry.id === selectedBuildingId);
    if (index !== -1) assignedBuildings[index] = result;
    alert('Settings saved.');
    loadBuildingSettings();
  }
}

async function loadApartments() {
  const container = document.getElementById('apartmentsTable');
  if (!selectedBuildingId) {
    container.innerHTML = '<div class="empty-state">Select a building to view apartments.</div>';
    return;
  }
  const data = await apiCall(`/api/management/buildings/${selectedBuildingId}/apartments`);
  if (!data) return;
  if (data.length === 0) {
    container.innerHTML = '<div class="empty-state">No apartments in this building.</div>';
    return;
  }
  let html = '<table><thead><tr><th>Number</th><th>Name</th><th>Residents</th><th>Actions</th></tr></thead><tbody>';
  for (const apartment of data) {
    html += `<tr><td>${esc(apartment.number)}</td><td>${esc(apartment.name || '—')}</td><td><button class="btn btn-outline btn-small" data-action="show-residents" data-apartment-id="${esc(apartment.id)}" data-apartment-number="${esc(apartment.number)}">Residents</button></td><td class="inline-actions"><button class="btn btn-outline btn-small" data-action="edit-apartment" data-apartment-id="${esc(apartment.id)}" data-apartment-number="${esc(apartment.number)}" data-apartment-name="${esc(apartment.name || '')}">Edit</button><button class="btn btn-danger btn-small" data-action="delete-apartment" data-apartment-id="${esc(apartment.id)}">Delete</button></td></tr>`;
  }
  html += '</tbody></table>';
  container.innerHTML = html;
}

async function createApartment() {
  if (!selectedBuildingId) return;
  const number = document.getElementById('aptNumber').value.trim();
  const name = document.getElementById('aptName').value.trim();
  if (!number) {
    alert('Apartment number is required.');
    return;
  }
  const result = await apiPost(`/api/management/buildings/${selectedBuildingId}/apartments`, { number, name });
  if (result) {
    document.getElementById('aptNumber').value = '';
    document.getElementById('aptName').value = '';
    loadApartments();
  }
}

function editApartment(id, number, name) {
  openModal('Edit Apartment', `<div class="form-group"><label>Number</label><input id="m-aNum" value="${esc(number)}" /></div><div class="form-group"><label>Name</label><input id="m-aName" value="${esc(name)}" /></div>`, async () => {
    const result = await apiPut(`/api/management/apartments/${id}`, {
      number: document.getElementById('m-aNum').value,
      name: document.getElementById('m-aName').value || null,
    });
    if (result) {
      closeModal();
      loadApartments();
    }
  });
}

async function deleteApartment(id) {
  if (!confirm('Delete this apartment?')) return;
  await apiDelete(`/api/management/apartments/${id}`);
  loadApartments();
}

async function showResidents(apartmentId, apartmentNumber) {
  const residents = await apiCall(`/api/management/apartments/${apartmentId}/residents`);
  let html = `<p style="margin-bottom:12px;">Residents in apartment <strong>${esc(apartmentNumber)}</strong>:</p>`;
  if (residents && residents.length > 0) {
    html += '<table><thead><tr><th>Name</th><th>Email</th><th>Action</th></tr></thead><tbody>';
    for (const resident of residents) {
      html += `<tr><td>${esc(resident.name)}</td><td>${esc(resident.email)}</td><td><button class="btn btn-danger btn-small" data-action="remove-resident" data-apartment-id="${esc(apartmentId)}" data-user-id="${esc(resident.id)}" data-apartment-number="${esc(apartmentNumber)}">Remove</button></td></tr>`;
    }
    html += '</tbody></table>';
  } else {
    html += '<div class="empty-state">No residents assigned.</div>';
  }
  html += `<div class="form-row" style="margin-top:16px;"><div class="form-group"><label>User ID</label><input id="addResId" placeholder="User UUID" /></div><button class="btn btn-success btn-small" data-action="assign-resident" data-apartment-id="${esc(apartmentId)}" data-apartment-number="${esc(apartmentNumber)}">Assign</button></div>`;
  openAssignModal('Apartment Residents', html);
}

async function assignResident(apartmentId, apartmentNumber) {
  const userId = document.getElementById('addResId').value.trim();
  if (!userId) return;
  await apiPost(`/api/management/apartments/${apartmentId}/residents`, { user_id: userId });
  showResidents(apartmentId, apartmentNumber);
}

async function removeResident(apartmentId, userId, apartmentNumber) {
  if (!confirm('Remove this resident?')) return;
  await apiDelete(`/api/management/apartments/${apartmentId}/residents/${userId}`);
  showResidents(apartmentId, apartmentNumber);
}

async function loadDevices() {
  const container = document.getElementById('devicesTable');
  const data = await apiCall('/api/management/devices');
  if (!data) return;
  const filtered = selectedBuildingId ? data.filter((device) => device.building_id === selectedBuildingId) : data;
  if (filtered.length === 0) {
    container.innerHTML = '<div class="empty-state">No intercoms.</div>';
    return;
  }
  let html = '<table><thead><tr><th>Name</th><th>Building</th><th>Gate ID</th><th>Door Code</th><th>Status</th><th>Action</th></tr></thead><tbody>';
  for (const device of filtered) {
    html += `<tr><td>${esc(device.name)}</td><td>${esc(device.building_name)}</td><td>${esc(device.gate_id || '—')}</td><td><code>${esc(device.door_code || '—')}</code></td><td><span class="status-badge status-${device.status}">${device.status}</span></td><td class="inline-actions"><button class="btn btn-danger btn-small" data-action="revoke-device" data-device-id="${esc(device.id)}">Revoke</button><button class="btn btn-outline btn-small" data-action="reprovision-device" data-device-id="${esc(device.id)}">Re-provision</button></td></tr>`;
  }
  html += '</tbody></table>';
  container.innerHTML = html;
}

async function createDevice() {
  if (!selectedBuildingId) return;
  const name = document.getElementById('devName').value.trim();
  const gateId = document.getElementById('devGate').value.trim();
  if (!name) {
    alert('Name is required.');
    return;
  }
  const result = await apiPost('/api/management/devices', { building_id: selectedBuildingId, name, gate_id: gateId });
  if (result) {
    const box = document.getElementById('devResult');
    box.className = 'result-box success';
    box.innerHTML = `Intercom created! Provisioning code: <span class="code-display">${esc(result.provisioning_code)}</span>`;
    document.getElementById('devName').value = '';
    document.getElementById('devGate').value = '';
    loadDevices();
  }
}

async function revokeDevice(id) {
  if (!confirm('Revoke this intercom?')) return;
  await apiPost(`/api/management/devices/${id}/revoke`, {});
  loadDevices();
}

async function reprovisionDevice(id) {
  if (!confirm('Re-provision this intercom? It will need to be set up again with a new code.')) return;
  const result = await apiPost(`/api/management/devices/${id}/reprovision`, {});
  if (result && result.provisioning_code) {
    const box = document.getElementById('devResult');
    box.className = 'result-box success';
    box.innerHTML = `New provisioning code: <span class="code-display">${esc(result.provisioning_code)}</span>`;
    loadDevices();
  }
}

async function loadNotifications() {
  const container = document.getElementById('notificationsTable');
  const data = await apiCall('/api/management/notifications');
  if (!data) return;
  const filtered = selectedBuildingId ? data.filter((notification) => notification.building_id === selectedBuildingId) : data;
  if (filtered.length === 0) {
    container.innerHTML = '<div class="empty-state">No notifications.</div>';
    return;
  }
  let html = '<table><thead><tr><th>Building</th><th>Message</th><th>Date</th><th>Action</th></tr></thead><tbody>';
  for (const notification of filtered) {
    html += `<tr><td>${esc(notification.building_name)}</td><td>${esc(notification.text)}</td><td>${fmtDate(notification.created_at)}</td><td><button class="btn btn-danger btn-small" data-action="delete-notification" data-notification-id="${esc(notification.id)}">Delete</button></td></tr>`;
  }
  html += '</tbody></table>';
  container.innerHTML = html;
}

async function createNotification() {
  if (!selectedBuildingId) return;
  const text = document.getElementById('notifText').value.trim();
  if (!text) {
    alert('Message is required.');
    return;
  }
  const result = await apiPost('/api/management/notifications', { building_id: selectedBuildingId, text });
  if (result) {
    document.getElementById('notifText').value = '';
    loadNotifications();
  }
}

async function deleteNotification(id) {
  if (!confirm('Delete this notification?')) return;
  await apiDelete(`/api/management/notifications/${id}`);
  loadNotifications();
}

async function loadAuditLogs() {
  const container = document.getElementById('auditTable');
  const params = new URLSearchParams();
  const eventType = document.getElementById('auditType').value;
  if (eventType) params.set('event_type', eventType);
  if (selectedBuildingId) params.set('building_id', selectedBuildingId);
  const queryString = params.toString();
  const data = await apiCall(`/api/management/audit-logs${queryString ? `?${queryString}` : ''}`);
  if (!data) return;
  if (data.length === 0) {
    container.innerHTML = '<div class="empty-state">No audit logs found.</div>';
    return;
  }
  let html = '<table><thead><tr><th>Time</th><th>Event</th><th>Building</th><th>User</th><th>Intercom</th><th>Description</th></tr></thead><tbody>';
  for (const entry of data) {
    html += `<tr><td style="white-space:nowrap;">${fmtDateTime(entry.created_at)}</td><td><span class="status-badge">${esc(entry.event_type)}</span></td><td>${esc(entry.building_name || '—')}</td><td>${esc(entry.user_name || '—')}</td><td>${esc(entry.intercom_name || '—')}</td><td>${esc(entry.description || '—')}</td></tr>`;
  }
  html += '</tbody></table>';
  container.innerHTML = html;
}

function openModal(title, bodyHtml, onSave) {
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalBody').innerHTML = bodyHtml;
  document.getElementById('modalSave').onclick = onSave;
  document.getElementById('editModal').classList.add('active');
}

function closeModal() {
  document.getElementById('editModal').classList.remove('active');
}

function openAssignModal(title, bodyHtml) {
  document.getElementById('assignTitle').textContent = title;
  document.getElementById('assignBody').innerHTML = bodyHtml;
  document.getElementById('assignModal').classList.add('active');
}

function closeAssignModal() {
  document.getElementById('assignModal').classList.remove('active');
}

function esc(str) {
  if (str == null) return '';
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

function fmtDate(iso) {
  return iso ? new Date(iso).toLocaleDateString() : '—';
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

async function loadDeviceHealth() {
  const container = document.getElementById('deviceHealthContent');
  if (!selectedBuildingId) {
    container.innerHTML = '<div class="empty-state">Select a building to view device health.</div>';
    return;
  }
  container.innerHTML = '<div class="spinner"></div> Loading…';
  const data = await apiCall(`/api/management/buildings/${selectedBuildingId}/device-health`);
  if (!data) {
    container.innerHTML = '<div class="empty-state">Failed to load device health.</div>';
    return;
  }
  if (data.length === 0) {
    container.innerHTML = '<div class="empty-state">No device health data yet.</div>';
    return;
  }
  let html = '<table><thead><tr><th>Apartment</th><th>Total Devices</th><th>Healthy</th><th>Degraded</th><th>Unhealthy</th><th>Status</th></tr></thead><tbody>';
  for (const row of data) {
    let color = '#636e72';
    if (row.apartment_health === 'ok') color = '#1e7a4a';
    if (row.apartment_health === 'at-risk') color = '#a66a00';
    if (row.apartment_health === 'critical') color = '#7c1e1e';
    html += `<tr><td>${esc(row.apartment_number || '—')}</td><td>${row.total_devices}</td><td>${row.healthy_devices}</td><td>${row.degraded_devices}</td><td>${row.unhealthy_devices}</td><td><span class="status-badge" style="background:#f1f2f6;color:${color};">${esc(row.apartment_health)}</span></td></tr>`;
  }
  html += '</tbody></table>';
  container.innerHTML = html;
}

async function loadDeliveryHealth() {
  const container = document.getElementById('deliveryHealthContent');
  if (!selectedBuildingId) {
    container.innerHTML = '<div class="empty-state">Select a building to view delivery health.</div>';
    return;
  }
  container.innerHTML = '<div class="spinner"></div> Loading…';
  const data = await apiCall('/api/management/delivery-health');
  if (!data) {
    container.innerHTML = '<div class="empty-state">Failed to load delivery health.</div>';
    return;
  }
  let html = '';
  html += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:24px;">';
  html += `<div style="background:#f1f2f6;border-radius:8px;padding:16px;text-align:center;"><div style="font-size:28px;font-weight:700;color:#0c2461;">${data.delivery_rate !== null ? `${data.delivery_rate}%` : '—'}</div><div style="font-size:13px;color:#636e72;">Delivery Rate (7d)</div></div>`;
  html += `<div style="background:#f1f2f6;border-radius:8px;padding:16px;text-align:center;"><div style="font-size:28px;font-weight:700;color:#0c2461;">${data.total_calls_7d || 0}</div><div style="font-size:13px;color:#636e72;">Total Calls (7d)</div></div>`;
  html += `<div style="background:#f1f2f6;border-radius:8px;padding:16px;text-align:center;"><div style="font-size:28px;font-weight:700;color:#0c2461;">${data.unhealthy_apartments.length}</div><div style="font-size:13px;color:#636e72;">Apartments w/o Tokens</div></div>`;
  html += '</div>';
  if (data.avg_latency && data.avg_latency.length > 0) {
    html += '<h3 style="font-size:14px;color:#636e72;margin-bottom:8px;text-transform:uppercase;">Avg Ack Latency by Platform (7d)</h3><table><thead><tr><th>Platform</th><th>Avg Latency (s)</th></tr></thead><tbody>';
    for (const latency of data.avg_latency) {
      html += `<tr><td>${esc(latency.platform)}</td><td>${latency.avg_latency_sec}s</td></tr>`;
    }
    html += '</tbody></table><br/>';
  }
  if (data.failed_deliveries && data.failed_deliveries.length > 0) {
    html += '<h3 style="font-size:14px;color:#636e72;margin-bottom:8px;text-transform:uppercase;">Failed Deliveries by Error (7d)</h3><table><thead><tr><th>Error</th><th>Count</th></tr></thead><tbody>';
    for (const failure of data.failed_deliveries) {
      html += `<tr><td>${esc(failure.last_error || 'Unknown')}</td><td>${failure.count}</td></tr>`;
    }
    html += '</tbody></table><br/>';
  }
  if (data.unhealthy_apartments && data.unhealthy_apartments.length > 0) {
    html += '<h3 style="font-size:14px;color:#636e72;margin-bottom:8px;text-transform:uppercase;">Apartments with No Device Tokens</h3><table><thead><tr><th>Apartment</th><th>Name</th><th>Building</th></tr></thead><tbody>';
    for (const apartment of data.unhealthy_apartments) {
      html += `<tr><td>${esc(apartment.number)}</td><td>${esc(apartment.name || '—')}</td><td>${esc(apartment.building_name)}</td></tr>`;
    }
    html += '</tbody></table><br/>';
  }
  html += '<h3 style="font-size:14px;color:#636e72;margin-bottom:8px;text-transform:uppercase;">Recent Calls</h3>';
  if (data.recent_calls.length === 0) {
    html += '<div class="empty-state">No recent calls.</div>';
  } else {
    html += '<table><thead><tr><th>Time</th><th>Apartment</th><th>Status</th><th>Targeted</th><th>Acked</th><th>Failed</th><th>Timed Out</th><th>Latency</th></tr></thead><tbody>';
    for (const call of data.recent_calls) {
      const latency = call.first_ack_latency_sec !== null ? `${call.first_ack_latency_sec.toFixed(1)}s` : '—';
      const statusClass = call.call_status === 'answered' ? 'status-connected' : (call.call_status === 'unanswered' ? 'status-disconnected' : '');
      html += `<tr><td style="white-space:nowrap;">${fmtDateTime(call.call_started_at)}</td><td>${esc(call.apartment_number || '—')}</td><td><span class="status-badge ${statusClass}">${esc(call.call_status)}</span></td><td>${call.devices_targeted}</td><td>${call.devices_acked}</td><td>${call.devices_failed}</td><td>${call.devices_timed_out}</td><td>${latency}</td></tr>`;
    }
    html += '</tbody></table>';
  }
  container.innerHTML = html;
}