const GOOGLE_CLIENT_ID = '1070504632843-t3ohfvsimcqsjspt31v8ajpvdffait6c.apps.googleusercontent.com';

let idToken = null;
let userEmail = null;
let userName = null;
let userPicture = null;
let cachedBuildings = [];
let cachedUsers = [];

window.addEventListener('DOMContentLoaded', () => {
  google.accounts.id.initialize({ client_id: GOOGLE_CLIENT_ID, callback: handleCredentialResponse });
  renderGoogleButton();

  document.addEventListener('click', handleClick);
  document.getElementById('aptBldgSelect').addEventListener('change', loadApartmentsSection);
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

  const action = actionTarget.dataset.action;
  switch (action) {
    case 'sign-out':
      handleSignOut();
      break;
    case 'show-section':
      showSection(actionTarget.dataset.sectionName, actionTarget);
      break;
    case 'load-buildings':
      loadBuildings();
      break;
    case 'create-building':
      createBuilding();
      break;
    case 'show-building-managers':
      showBuildingManagers(actionTarget.dataset.buildingId, actionTarget.dataset.buildingName);
      break;
    case 'edit-building':
      editBuilding(actionTarget.dataset.buildingId);
      break;
    case 'delete-building':
      deleteBuilding(actionTarget.dataset.buildingId);
      break;
    case 'assign-manager':
      assignManager(actionTarget.dataset.buildingId, actionTarget.dataset.buildingName);
      break;
    case 'remove-manager':
      removeManager(actionTarget.dataset.buildingId, actionTarget.dataset.userId, actionTarget.dataset.buildingName);
      break;
    case 'load-apartments':
      loadApartmentsSection();
      break;
    case 'create-apartment':
      createApartment();
      break;
    case 'show-apt-residents':
      showAptResidents(actionTarget.dataset.apartmentId, actionTarget.dataset.apartmentNumber);
      break;
    case 'edit-apartment':
      editApartment(actionTarget.dataset.apartmentId, actionTarget.dataset.apartmentNumber, actionTarget.dataset.apartmentName || '');
      break;
    case 'delete-apartment':
      deleteApartment(actionTarget.dataset.apartmentId);
      break;
    case 'assign-resident':
      assignResident(actionTarget.dataset.apartmentId, actionTarget.dataset.apartmentNumber);
      break;
    case 'remove-resident':
      removeResident(actionTarget.dataset.apartmentId, actionTarget.dataset.userId, actionTarget.dataset.apartmentNumber);
      break;
    case 'load-users':
      loadUsers();
      break;
    case 'create-user':
      createUser();
      break;
    case 'edit-user':
      editUser(actionTarget.dataset.userId);
      break;
    case 'delete-user':
      deleteUser(actionTarget.dataset.userId);
      break;
    case 'load-devices':
      loadDevices();
      break;
    case 'create-device':
      createDevice();
      break;
    case 'edit-device':
      editDevice(
        actionTarget.dataset.deviceId,
        actionTarget.dataset.deviceName,
        actionTarget.dataset.gateId || '',
        actionTarget.dataset.doorCode || '',
      );
      break;
    case 'revoke-device':
      revokeDevice(actionTarget.dataset.deviceId);
      break;
    case 'reprovision-device':
      reprovisionDevice(actionTarget.dataset.deviceId);
      break;
    case 'delete-device':
      deleteDevice(actionTarget.dataset.deviceId);
      break;
    case 'load-notifications':
      loadNotifications();
      break;
    case 'create-notification':
      createNotification();
      break;
    case 'delete-notification':
      deleteNotification(actionTarget.dataset.notificationId);
      break;
    case 'load-audit-logs':
      loadAuditLogs();
      break;
    case 'load-client-errors':
      loadClientErrors();
      break;
    case 'show-error-detail':
      showErrorDetail(actionTarget.dataset.errorId);
      break;
    case 'save-setting':
      saveSetting(actionTarget.dataset.key);
      break;
    case 'close-modal':
      closeModal();
      break;
    case 'close-assign-modal':
      closeAssignModal();
      break;
    case 'load-device-health-summary':
      loadDeviceHealthSummary();
      break;
    case 'load-delivery-health':
      loadDeliveryHealth();
      break;
    default:
      break;
  }
}

function handleCredentialResponse(response) {
  idToken = response.credential;
  const payload = JSON.parse(atob(idToken.split('.')[1]));
  userEmail = payload.email;
  userName = payload.name;
  userPicture = payload.picture;
  testAdminAccess();
}

async function testAdminAccess() {
  const res = await apiCall('/api/admin/buildings');
  if (res === null) {
    showAccessDenied();
    return;
  }
  showAdminUI();
  loadAll();
}

function handleSignOut() {
  google.accounts.id.disableAutoSelect();
  idToken = null;
  userEmail = null;
  userName = null;
  userPicture = null;
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
  document.getElementById('adminContent').style.display = 'none';
  renderGoogleButton();
}

function showAccessDenied() {
  document.getElementById('loginPrompt').style.display = 'none';
  document.getElementById('accessDenied').style.display = '';
  document.getElementById('adminContent').style.display = 'none';
  renderUserInfo(userEmail || 'Unknown user');
}

function showAdminUI() {
  document.getElementById('loginPrompt').style.display = 'none';
  document.getElementById('accessDenied').style.display = 'none';
  document.getElementById('adminContent').style.display = '';
  renderUserInfo(userName || userEmail || 'Unknown user', userPicture || '');
}

function showSection(name, button) {
  document.querySelectorAll('.section').forEach((section) => section.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach((tab) => tab.classList.remove('active'));
  document.getElementById(`sec-${name}`).classList.add('active');
  if (button) button.classList.add('active');
}

async function apiCall(url, options = {}) {
  const headers = { Authorization: `Bearer ${idToken}`, ...options.headers };
  try {
    const res = await fetch(url, { ...options, headers });
    if (res.status === 401) {
      handleSignOut();
      return null;
    }
    const data = await res.json();
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

async function loadAll() {
  await loadBuildings();
  loadUsers();
  loadDevices();
  loadNotifications();
  loadAuditLogs();
  loadClientErrors();
  loadSettings();
  loadDeviceHealthSummary();
  loadDeliveryHealth();
}

async function loadBuildings() {
  const data = await apiCall('/api/admin/buildings');
  if (!data) return;
  cachedBuildings = data;
  populateBuildingSelects();

  if (data.length === 0) {
    document.getElementById('buildingsTable').innerHTML = '<div class="empty-state">No buildings yet.</div>';
    return;
  }

  let html = '<table><thead><tr><th>Name</th><th>Address</th><th>Apartments</th><th>Actions</th></tr></thead><tbody>';
  for (const building of data) {
    html += `<tr>
      <td>${esc(building.name)}</td>
      <td>${esc(building.address)}</td>
      <td><button class="btn btn-outline btn-small" data-action="show-building-managers" data-building-id="${esc(building.id)}" data-building-name="${esc(building.name)}">Managers</button></td>
      <td class="inline-actions">
        <button class="btn btn-outline btn-small" data-action="edit-building" data-building-id="${esc(building.id)}">Edit</button>
        <button class="btn btn-danger btn-small" data-action="delete-building" data-building-id="${esc(building.id)}">Delete</button>
      </td>
    </tr>`;
  }
  html += '</tbody></table>';
  document.getElementById('buildingsTable').innerHTML = html;
}

async function createBuilding() {
  const name = document.getElementById('bldgName').value.trim();
  const address = document.getElementById('bldgAddr').value.trim();
  if (!name || !address) {
    alert('Name and address are required.');
    return;
  }
  const result = await apiPost('/api/admin/buildings', { name, address });
  if (result) {
    document.getElementById('bldgName').value = '';
    document.getElementById('bldgAddr').value = '';
    loadBuildings();
  }
}

function editBuilding(id) {
  const building = cachedBuildings.find((entry) => entry.id === id);
  if (!building) return;

  openModal(
    'Edit Building',
    `
      <div class="form-group"><label>Name</label><input id="m-bName" value="${esc(building.name)}" /></div>
      <div class="form-group"><label>Address</label><input id="m-bAddr" value="${esc(building.address)}" /></div>
      <div class="form-group"><label>Door Opening Time (s)</label><input type="number" id="m-bDoorTime" value="${building.door_opening_time}" /></div>
      <div class="form-group"><label>No Answer Timeout (s)</label><input type="number" id="m-bTimeout" value="${building.no_answer_timeout}" /></div>
      <div class="form-group"><label>Language</label><input id="m-bLang" value="${esc(building.language)}" /></div>
      <div class="form-group"><label>Volume (0-100)</label><input type="number" id="m-bVol" value="${building.volume}" min="0" max="100" /></div>
      <div class="form-group"><label>Brightness (0-100)</label><input type="number" id="m-bBright" value="${building.brightness}" min="0" max="100" /></div>
    `,
    async () => {
      const result = await apiPut(`/api/admin/buildings/${id}`, {
        name: document.getElementById('m-bName').value,
        address: document.getElementById('m-bAddr').value,
        door_opening_time: parseInt(document.getElementById('m-bDoorTime').value, 10),
        no_answer_timeout: parseInt(document.getElementById('m-bTimeout').value, 10),
        language: document.getElementById('m-bLang').value,
        volume: parseInt(document.getElementById('m-bVol').value, 10),
        brightness: parseInt(document.getElementById('m-bBright').value, 10),
      });
      if (result) {
        closeModal();
        loadBuildings();
      }
    },
  );
}

async function deleteBuilding(id) {
  if (!confirm('Delete this building and all its data?')) return;
  const result = await apiDelete(`/api/admin/buildings/${id}`);
  if (result) loadBuildings();
}

async function showBuildingManagers(buildingId, buildingName) {
  const managers = await apiCall(`/api/admin/buildings/${buildingId}/managers`);
  let html = `<p style="margin-bottom:12px;">Managers assigned to <strong>${esc(buildingName)}</strong>:</p>`;
  if (managers && managers.length > 0) {
    html += '<table><thead><tr><th>Name</th><th>Email</th><th>Action</th></tr></thead><tbody>';
    for (const manager of managers) {
      html += `<tr><td>${esc(manager.name)}</td><td>${esc(manager.email)}</td><td><button class="btn btn-danger btn-small" data-action="remove-manager" data-building-id="${esc(buildingId)}" data-user-id="${esc(manager.id)}" data-building-name="${esc(buildingName)}">Remove</button></td></tr>`;
    }
    html += '</tbody></table>';
  } else {
    html += '<div class="empty-state">No managers assigned.</div>';
  }

  html += `
    <div class="form-row" style="margin-top:16px;">
      <div class="form-group"><label>Add Manager (select user)</label><select id="addMgrSelect"></select></div>
      <button class="btn btn-success btn-small" data-action="assign-manager" data-building-id="${esc(buildingId)}" data-building-name="${esc(buildingName)}">Assign</button>
    </div>
  `;

  openAssignModal('Building Managers', html);
  const users = await apiCall('/api/admin/users');
  const select = document.getElementById('addMgrSelect');
  select.innerHTML = '';
  if (users) {
    users.filter((user) => user.role === 'manager').forEach((user) => {
      select.innerHTML += `<option value="${esc(user.id)}">${esc(user.name)} (${esc(user.email)})</option>`;
    });
  }
}

async function assignManager(buildingId, buildingName) {
  const userId = document.getElementById('addMgrSelect').value;
  if (!userId) return;
  await apiPost(`/api/admin/buildings/${buildingId}/managers`, { user_id: userId });
  showBuildingManagers(buildingId, buildingName);
}

async function removeManager(buildingId, userId, buildingName) {
  if (!confirm('Remove this manager?')) return;
  await apiDelete(`/api/admin/buildings/${buildingId}/managers/${userId}`);
  showBuildingManagers(buildingId, buildingName);
}

async function loadApartmentsSection() {
  const buildingId = document.getElementById('aptBldgSelect').value;
  if (!buildingId) {
    document.getElementById('apartmentsTable').innerHTML = '<div class="empty-state">Select a building first.</div>';
    return;
  }

  const data = await apiCall(`/api/admin/buildings/${buildingId}/apartments`);
  if (!data) return;
  if (data.length === 0) {
    document.getElementById('apartmentsTable').innerHTML = '<div class="empty-state">No apartments in this building.</div>';
    return;
  }

  let html = '<table><thead><tr><th>Number</th><th>Name</th><th>Residents</th><th>Actions</th></tr></thead><tbody>';
  for (const apartment of data) {
    html += `<tr>
      <td>${esc(apartment.number)}</td>
      <td>${esc(apartment.name || '—')}</td>
      <td><button class="btn btn-outline btn-small" data-action="show-apt-residents" data-apartment-id="${esc(apartment.id)}" data-apartment-number="${esc(apartment.number)}">Residents</button></td>
      <td class="inline-actions">
        <button class="btn btn-outline btn-small" data-action="edit-apartment" data-apartment-id="${esc(apartment.id)}" data-apartment-number="${esc(apartment.number)}" data-apartment-name="${esc(apartment.name || '')}">Edit</button>
        <button class="btn btn-danger btn-small" data-action="delete-apartment" data-apartment-id="${esc(apartment.id)}">Delete</button>
      </td>
    </tr>`;
  }
  html += '</tbody></table>';
  document.getElementById('apartmentsTable').innerHTML = html;
}

async function createApartment() {
  const buildingId = document.getElementById('aptBldgSelect').value;
  const number = document.getElementById('aptNumber').value.trim();
  const name = document.getElementById('aptName').value.trim();
  if (!buildingId || !number) {
    alert('Select a building and enter apartment number.');
    return;
  }
  const result = await apiPost(`/api/admin/buildings/${buildingId}/apartments`, { number, name });
  if (result) {
    document.getElementById('aptNumber').value = '';
    document.getElementById('aptName').value = '';
    loadApartmentsSection();
  }
}

function editApartment(id, number, name) {
  openModal(
    'Edit Apartment',
    `
      <div class="form-group"><label>Number</label><input id="m-aNum" value="${esc(number)}" /></div>
      <div class="form-group"><label>Name</label><input id="m-aName" value="${esc(name)}" /></div>
    `,
    async () => {
      const result = await apiPut(`/api/admin/apartments/${id}`, {
        number: document.getElementById('m-aNum').value,
        name: document.getElementById('m-aName').value || null,
      });
      if (result) {
        closeModal();
        loadApartmentsSection();
      }
    },
  );
}

async function deleteApartment(id) {
  if (!confirm('Delete this apartment?')) return;
  const result = await apiDelete(`/api/admin/apartments/${id}`);
  if (result) loadApartmentsSection();
}

async function showAptResidents(apartmentId, apartmentNumber) {
  const residents = await apiCall(`/api/admin/apartments/${apartmentId}/residents`);
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
  html += `
    <div class="form-row" style="margin-top:16px;">
      <div class="form-group"><label>Add Resident</label><select id="addResSelect"></select></div>
      <button class="btn btn-success btn-small" data-action="assign-resident" data-apartment-id="${esc(apartmentId)}" data-apartment-number="${esc(apartmentNumber)}">Assign</button>
    </div>
  `;
  openAssignModal('Apartment Residents', html);
  const users = await apiCall('/api/admin/users');
  const select = document.getElementById('addResSelect');
  select.innerHTML = '';
  if (users) {
    users.filter((user) => user.role === 'resident').forEach((user) => {
      select.innerHTML += `<option value="${esc(user.id)}">${esc(user.name)} (${esc(user.email)})</option>`;
    });
  }
}

async function assignResident(apartmentId, apartmentNumber) {
  const userId = document.getElementById('addResSelect').value;
  if (!userId) return;
  await apiPost(`/api/admin/apartments/${apartmentId}/residents`, { user_id: userId });
  showAptResidents(apartmentId, apartmentNumber);
}

async function removeResident(apartmentId, userId, apartmentNumber) {
  if (!confirm('Remove this resident?')) return;
  await apiDelete(`/api/admin/apartments/${apartmentId}/residents/${userId}`);
  showAptResidents(apartmentId, apartmentNumber);
}

async function loadUsers() {
  const data = await apiCall('/api/admin/users');
  if (!data) return;
  cachedUsers = data;
  if (data.length === 0) {
    document.getElementById('usersTable').innerHTML = '<div class="empty-state">No users yet.</div>';
    return;
  }

  let html = '<table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Created</th><th>Actions</th></tr></thead><tbody>';
  for (const user of data) {
    html += `<tr>
      <td>${esc(user.name)}</td>
      <td>${esc(user.email)}</td>
      <td><span class="status-badge role-${user.role}">${user.role}</span></td>
      <td>${fmtDate(user.created_at)}</td>
      <td class="inline-actions">
        <button class="btn btn-outline btn-small" data-action="edit-user" data-user-id="${esc(user.id)}">Edit</button>
        <button class="btn btn-danger btn-small" data-action="delete-user" data-user-id="${esc(user.id)}">Delete</button>
      </td>
    </tr>`;
  }
  html += '</tbody></table>';
  document.getElementById('usersTable').innerHTML = html;
}

async function createUser() {
  const email = document.getElementById('userEmail').value.trim();
  const name = document.getElementById('userName').value.trim();
  const role = document.getElementById('userRole').value;
  if (!email || !name) {
    alert('Email and name are required.');
    return;
  }
  const result = await apiPost('/api/admin/users', { email, name, role });
  if (result) {
    document.getElementById('userEmail').value = '';
    document.getElementById('userName').value = '';
    loadUsers();
  }
}

function editUser(id) {
  const user = cachedUsers.find((entry) => entry.id === id);
  if (!user) return;

  openModal(
    'Edit User',
    `
      <div class="form-group"><label>Email</label><input id="m-uEmail" value="${esc(user.email)}" /></div>
      <div class="form-group"><label>Name</label><input id="m-uName" value="${esc(user.name)}" /></div>
      <div class="form-group"><label>Role</label><select id="m-uRole">
        <option value="resident" ${user.role === 'resident' ? 'selected' : ''}>Resident</option>
        <option value="manager" ${user.role === 'manager' ? 'selected' : ''}>Manager</option>
        <option value="admin" ${user.role === 'admin' ? 'selected' : ''}>Admin</option>
      </select></div>
    `,
    async () => {
      const result = await apiPut(`/api/admin/users/${id}`, {
        email: document.getElementById('m-uEmail').value,
        name: document.getElementById('m-uName').value,
        role: document.getElementById('m-uRole').value,
      });
      if (result) {
        closeModal();
        loadUsers();
      }
    },
  );
}

async function deleteUser(id) {
  if (!confirm('Delete this user?')) return;
  const result = await apiDelete(`/api/admin/users/${id}`);
  if (result) loadUsers();
}

async function loadDevices() {
  const data = await apiCall('/api/admin/devices');
  if (!data) return;
  if (data.length === 0) {
    document.getElementById('devicesTable').innerHTML = '<div class="empty-state">No intercoms yet.</div>';
    return;
  }

  let html = '<table><thead><tr><th>Name</th><th>Building</th><th>Gate ID</th><th>Door Code</th><th>Status</th><th>Actions</th></tr></thead><tbody>';
  for (const device of data) {
    html += `<tr>
      <td>${esc(device.name)}</td>
      <td>${esc(device.building_name)}</td>
      <td>${esc(device.gate_id || '—')}</td>
      <td><code>${esc(device.door_code || '—')}</code></td>
      <td><span class="status-badge status-${device.status}">${device.status}</span></td>
      <td class="inline-actions">
        <button class="btn btn-outline btn-small" data-action="edit-device" data-device-id="${esc(device.id)}" data-device-name="${esc(device.name)}" data-gate-id="${esc(device.gate_id || '')}" data-door-code="${esc(device.door_code || '')}">Edit</button>
        <button class="btn btn-danger btn-small" data-action="revoke-device" data-device-id="${esc(device.id)}">Revoke</button>
        <button class="btn btn-outline btn-small" data-action="reprovision-device" data-device-id="${esc(device.id)}">Re-provision</button>
        <button class="btn btn-danger btn-small" data-action="delete-device" data-device-id="${esc(device.id)}">Delete</button>
      </td>
    </tr>`;
  }
  html += '</tbody></table>';
  document.getElementById('devicesTable').innerHTML = html;
}

async function createDevice() {
  const buildingId = document.getElementById('devBldgSelect').value;
  const name = document.getElementById('devName').value.trim();
  const gateId = document.getElementById('devGate').value.trim();
  const doorCode = document.getElementById('devCode').value.trim();
  if (!buildingId || !name) {
    alert('Select a building and enter a name.');
    return;
  }
  const result = await apiPost('/api/admin/devices', { building_id: buildingId, name, gate_id: gateId, door_code: doorCode });
  if (result) {
    const box = document.getElementById('devResult');
    box.className = 'result-box success';
    box.innerHTML = `Intercom created! Provisioning code: <span class="code-display">${esc(result.provisioning_code)}</span>`;
    document.getElementById('devName').value = '';
    document.getElementById('devGate').value = '';
    document.getElementById('devCode').value = '';
    loadDevices();
  }
}

function editDevice(id, name, gateId, doorCode) {
  openModal(
    'Edit Intercom',
    `
      <div class="form-group"><label>Name</label><input id="m-dName" value="${esc(name)}" /></div>
      <div class="form-group"><label>Gate ID</label><input id="m-dGate" value="${esc(gateId)}" /></div>
      <div class="form-group"><label>Door Code</label><input id="m-dCode" value="${esc(doorCode)}" /></div>
    `,
    async () => {
      const result = await apiPut(`/api/admin/devices/${id}`, {
        name: document.getElementById('m-dName').value,
        gate_id: document.getElementById('m-dGate').value || null,
        door_code: document.getElementById('m-dCode').value || null,
      });
      if (result) {
        closeModal();
        loadDevices();
      }
    },
  );
}

async function revokeDevice(id) {
  if (!confirm('Revoke this intercom?')) return;
  await apiPost(`/api/admin/devices/${id}/revoke`, {});
  loadDevices();
}

async function reprovisionDevice(id) {
  if (!confirm('Re-provision this intercom? It will need to be set up again with a new code.')) return;
  const result = await apiPost(`/api/admin/devices/${id}/reprovision`, {});
  if (result && result.provisioning_code) {
    const box = document.getElementById('devResult');
    box.className = 'result-box success';
    box.innerHTML = `New provisioning code: <span class="code-display">${esc(result.provisioning_code)}</span>`;
    loadDevices();
  }
}

async function deleteDevice(id) {
  if (!confirm('Delete this intercom permanently?')) return;
  await apiDelete(`/api/admin/devices/${id}`);
  loadDevices();
}

async function loadNotifications() {
  const data = await apiCall('/api/admin/notifications');
  if (!data) return;
  if (data.length === 0) {
    document.getElementById('notificationsTable').innerHTML = '<div class="empty-state">No notifications yet.</div>';
    return;
  }

  let html = '<table><thead><tr><th>Building</th><th>Message</th><th>Date</th><th>Action</th></tr></thead><tbody>';
  for (const notification of data) {
    html += `<tr>
      <td>${esc(notification.building_name)}</td>
      <td>${esc(notification.text)}</td>
      <td>${fmtDate(notification.created_at)}</td>
      <td><button class="btn btn-danger btn-small" data-action="delete-notification" data-notification-id="${esc(notification.id)}">Delete</button></td>
    </tr>`;
  }
  html += '</tbody></table>';
  document.getElementById('notificationsTable').innerHTML = html;
}

async function createNotification() {
  const buildingId = document.getElementById('notifBldgSelect').value;
  const text = document.getElementById('notifText').value.trim();
  if (!buildingId || !text) {
    alert('Select a building and enter a message.');
    return;
  }
  const result = await apiPost('/api/admin/notifications', { building_id: buildingId, text });
  if (result) {
    document.getElementById('notifText').value = '';
    loadNotifications();
  }
}

async function deleteNotification(id) {
  if (!confirm('Delete this notification?')) return;
  await apiDelete(`/api/admin/notifications/${id}`);
  loadNotifications();
}

async function loadAuditLogs() {
  const params = new URLSearchParams();
  const type = document.getElementById('auditType').value;
  const buildingId = document.getElementById('auditBldg').value;
  if (type) params.set('event_type', type);
  if (buildingId) params.set('building_id', buildingId);
  const queryString = params.toString();
  const data = await apiCall(`/api/admin/audit-logs${queryString ? `?${queryString}` : ''}`);
  if (!data) return;
  if (data.length === 0) {
    document.getElementById('auditTable').innerHTML = '<div class="empty-state">No audit logs found.</div>';
    return;
  }

  let html = '<table><thead><tr><th>Time</th><th>Event</th><th>Building</th><th>User</th><th>Intercom</th><th>Description</th></tr></thead><tbody>';
  for (const log of data) {
    html += `<tr>
      <td style="white-space:nowrap;">${fmtDateTime(log.created_at)}</td>
      <td><span class="status-badge">${esc(log.event_type)}</span></td>
      <td>${esc(log.building_name || '—')}</td>
      <td>${esc(log.user_name || '—')}</td>
      <td>${esc(log.intercom_name || '—')}</td>
      <td>${esc(log.description || '—')}</td>
    </tr>`;
  }
  html += '</tbody></table>';
  document.getElementById('auditTable').innerHTML = html;
}

async function loadClientErrors() {
  const params = new URLSearchParams();
  const app = document.getElementById('errApp').value;
  const buildingId = document.getElementById('errBldg').value;
  if (app) params.set('app', app);
  if (buildingId) params.set('building_id', buildingId);
  const queryString = params.toString();
  const data = await apiCall(`/api/admin/client-errors${queryString ? `?${queryString}` : ''}`);
  if (!data) return;
  if (data.length === 0) {
    document.getElementById('errorsTable').innerHTML = '<div class="empty-state">No client errors found.</div>';
    return;
  }

  let html = '<table><thead><tr><th>Time</th><th>App</th><th>Type</th><th>Message</th><th>Platform</th><th>User / Device</th><th>Building</th></tr></thead><tbody>';
  for (const clientError of data) {
    const who = clientError.user_email || (clientError.intercom_id ? `Intercom ${clientError.intercom_id.slice(0, 8)}…` : '—');
    const platform = [clientError.platform, clientError.os_version].filter(Boolean).join(' ') || '—';
    const msgShort = esc(clientError.message).length > 120 ? `${esc(clientError.message).substring(0, 120)}…` : esc(clientError.message);
    html += `<tr data-action="show-error-detail" data-error-id="${esc(clientError.id)}" style="cursor:pointer;">
      <td style="white-space:nowrap;">${fmtDateTime(clientError.created_at)}</td>
      <td><span class="status-badge" style="background:${clientError.app === 'home' ? '#74b9ff' : '#a29bfe'};color:#fff;">${esc(clientError.app)}</span></td>
      <td>${esc(clientError.error_type)}</td>
      <td style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(clientError.message)}">${msgShort}</td>
      <td>${platform}</td>
      <td>${who}</td>
      <td>${esc(clientError.building_name || '—')}</td>
    </tr>`;
  }
  html += '</tbody></table>';
  document.getElementById('errorsTable').innerHTML = html;
  window._clientErrors = data;
}

function showErrorDetail(id) {
  const clientError = (window._clientErrors || []).find((entry) => entry.id === id);
  if (!clientError) return;
  let detail = `<div class="form-group"><label>App</label><div>${esc(clientError.app)}</div></div>`;
  detail += `<div class="form-group"><label>Error Type</label><div>${esc(clientError.error_type)}</div></div>`;
  detail += `<div class="form-group"><label>Message</label><div style="word-break:break-all;">${esc(clientError.message)}</div></div>`;
  if (clientError.stack) detail += `<div class="form-group"><label>Stack Trace</label><pre style="background:#f1f2f6;padding:8px;border-radius:4px;font-size:12px;max-height:200px;overflow:auto;white-space:pre-wrap;">${esc(clientError.stack)}</pre></div>`;
  if (clientError.context) detail += `<div class="form-group"><label>Context</label><pre style="background:#f1f2f6;padding:8px;border-radius:4px;font-size:12px;max-height:200px;overflow:auto;white-space:pre-wrap;">${esc(JSON.stringify(clientError.context, null, 2))}</pre></div>`;
  detail += `<div class="form-group"><label>Platform</label><div>${esc(clientError.platform || '—')} ${esc(clientError.os_version || '')}</div></div>`;
  if (clientError.device_model) detail += `<div class="form-group"><label>Device Model</label><div>${esc(clientError.device_model)}</div></div>`;
  if (clientError.user_email) detail += `<div class="form-group"><label>User</label><div>${esc(clientError.user_email)}</div></div>`;
  if (clientError.building_name) detail += `<div class="form-group"><label>Building</label><div>${esc(clientError.building_name)}</div></div>`;
  if (clientError.intercom_id) detail += `<div class="form-group"><label>Intercom ID</label><div>${esc(clientError.intercom_id)}</div></div>`;
  detail += `<div class="form-group"><label>Time</label><div>${fmtDateTime(clientError.created_at)}</div></div>`;
  openModal('Error Detail', detail, () => closeModal());
}

async function loadSettings() {
  const data = await apiCall('/api/admin/settings');
  if (!data) return;
  if (data.length === 0) {
    document.getElementById('settingsTable').innerHTML = '<div class="empty-state">No settings configured.</div>';
    return;
  }

  let html = '<table><thead><tr><th>Key</th><th>Value</th><th>Description</th><th>Action</th></tr></thead><tbody>';
  for (const setting of data) {
    html += `<tr>
      <td><code>${esc(setting.key)}</code></td>
      <td><input id="setting-${esc(setting.key)}" value="${esc(setting.value)}" style="width:80px;padding:4px 8px;border:1px solid #dfe6e9;border-radius:4px;" /></td>
      <td style="color:#636e72;font-size:13px;">${esc(setting.description || '')}</td>
      <td><button class="btn btn-primary btn-small" data-action="save-setting" data-key="${esc(setting.key)}">Save</button></td>
    </tr>`;
  }
  html += '</tbody></table>';
  document.getElementById('settingsTable').innerHTML = html;
}

async function saveSetting(key) {
  const value = document.getElementById(`setting-${key}`).value;
  await apiPut(`/api/admin/settings/${encodeURIComponent(key)}`, { value });
}

function populateBuildingSelects() {
  const selectors = ['aptBldgSelect', 'devBldgSelect', 'notifBldgSelect', 'auditBldg', 'errBldg'];
  for (const selectorId of selectors) {
    const select = document.getElementById(selectorId);
    if (!select) continue;
    const previousValue = select.value;
    select.innerHTML = selectorId === 'auditBldg' || selectorId === 'errBldg' ? '<option value="">All</option>' : '';
    for (const building of cachedBuildings) {
      select.innerHTML += `<option value="${esc(building.id)}">${esc(building.name)}</option>`;
    }
    if (previousValue) select.value = previousValue;
  }
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

async function loadDeviceHealthSummary() {
  const container = document.getElementById('deviceHealthSummaryContent');
  container.innerHTML = '<div class="spinner"></div> Loading…';
  const data = await apiCall('/api/admin/device-health/summary');
  if (!data) {
    container.innerHTML = '<div class="empty-state">Failed to load device health.</div>';
    return;
  }

  const totals = data.totals || {};
  let html = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:24px;">';
  html += `<div style="background:#f1f2f6;border-radius:8px;padding:16px;text-align:center;"><div style="font-size:28px;font-weight:700;color:#0984e3;">${totals.total_devices || 0}</div><div style="font-size:13px;color:#636e72;">Total Devices</div></div>`;
  html += `<div style="background:#f1f2f6;border-radius:8px;padding:16px;text-align:center;"><div style="font-size:28px;font-weight:700;color:#00b894;">${totals.healthy_devices || 0}</div><div style="font-size:13px;color:#636e72;">Healthy</div></div>`;
  html += `<div style="background:#f1f2f6;border-radius:8px;padding:16px;text-align:center;"><div style="font-size:28px;font-weight:700;color:#e1a400;">${totals.degraded_devices || 0}</div><div style="font-size:13px;color:#636e72;">Degraded</div></div>`;
  html += `<div style="background:#f1f2f6;border-radius:8px;padding:16px;text-align:center;"><div style="font-size:28px;font-weight:700;color:#d63031;">${totals.unhealthy_devices || 0}</div><div style="font-size:13px;color:#636e72;">Unhealthy</div></div>`;
  html += `<div style="background:#f1f2f6;border-radius:8px;padding:16px;text-align:center;"><div style="font-size:28px;font-weight:700;color:#d63031;">${totals.critical_apartments || 0}</div><div style="font-size:13px;color:#636e72;">Critical Apartments</div></div>`;
  html += '</div>';

  const byBuilding = data.by_building || [];
  html += '<h3 style="font-size:14px;color:#636e72;margin-bottom:8px;text-transform:uppercase;">By Building</h3>';
  if (byBuilding.length === 0) {
    html += '<div class="empty-state">No device health data yet.</div>';
  } else {
    html += '<table><thead><tr><th>Building</th><th>Apartments</th><th>Critical</th><th>Total Devices</th><th>Healthy</th><th>Degraded</th><th>Unhealthy</th></tr></thead><tbody>';
    for (const building of byBuilding) {
      html += `<tr>
        <td>${esc(building.building_name)}</td>
        <td>${building.apartments}</td>
        <td style="font-weight:700;${building.critical_apartments > 0 ? 'color:#d63031;' : 'color:#00b894;'}">${building.critical_apartments}</td>
        <td>${building.total_devices || 0}</td>
        <td>${building.healthy_devices || 0}</td>
        <td>${building.degraded_devices || 0}</td>
        <td>${building.unhealthy_devices || 0}</td>
      </tr>`;
    }
    html += '</tbody></table>';
  }

  container.innerHTML = html;
}

async function loadDeliveryHealth() {
  const container = document.getElementById('deliveryHealthContent');
  container.innerHTML = '<div class="spinner"></div> Loading…';
  const data = await apiCall('/api/admin/delivery-health');
  if (!data) {
    container.innerHTML = '<div class="empty-state">Failed to load delivery health.</div>';
    return;
  }

  let html = '<h3 style="font-size:14px;color:#636e72;margin-bottom:8px;text-transform:uppercase;">Delivery Rate by Building (7d)</h3>';
  if (data.rate_by_building.length === 0) {
    html += '<div class="empty-state">No call data in the last 7 days.</div>';
  } else {
    html += '<table><thead><tr><th>Building</th><th>Total Calls</th><th>Calls Acked</th><th>Delivery Rate</th></tr></thead><tbody>';
    for (const building of data.rate_by_building) {
      const rateColor = building.delivery_rate === null ? '' : (building.delivery_rate >= 80 ? 'color:#00b894;' : (building.delivery_rate >= 50 ? 'color:#fdcb6e;' : 'color:#d63031;'));
      html += `<tr>
        <td>${esc(building.building_name)}</td>
        <td>${building.total_calls}</td>
        <td>${building.calls_with_ack}</td>
        <td style="font-weight:700;${rateColor}">${building.delivery_rate !== null ? `${building.delivery_rate}%` : '—'}</td>
      </tr>`;
    }
    html += '</tbody></table><br/>';
  }

  const tokenHealth = data.token_health;
  const retryEffectiveness = data.retry_effectiveness;
  html += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:24px;">';
  html += `<div style="background:#f1f2f6;border-radius:8px;padding:16px;text-align:center;"><div style="font-size:28px;font-weight:700;color:#0984e3;">${tokenHealth.total_tokens || 0}</div><div style="font-size:13px;color:#636e72;">Total Tokens</div></div>`;
  html += `<div style="background:#f1f2f6;border-radius:8px;padding:16px;text-align:center;"><div style="font-size:28px;font-weight:700;color:${tokenHealth.stale_tokens > 0 ? '#d63031' : '#00b894'};">${tokenHealth.stale_tokens || 0}</div><div style="font-size:13px;color:#636e72;">Stale Tokens (>30d)</div></div>`;
  html += `<div style="background:#f1f2f6;border-radius:8px;padding:16px;text-align:center;"><div style="font-size:28px;font-weight:700;color:#0984e3;">${retryEffectiveness.effectiveness_pct !== null ? `${retryEffectiveness.effectiveness_pct}%` : '—'}</div><div style="font-size:13px;color:#636e72;">Retry Effectiveness</div><div style="font-size:11px;color:#b2bec3;">${retryEffectiveness.retried_and_acked} / ${retryEffectiveness.retried_devices} retried</div></div>`;
  html += '</div>';

  html += '<h3 style="font-size:14px;color:#636e72;margin-bottom:8px;text-transform:uppercase;">Delivery-Degraded Events (7d)</h3>';
  if (data.degraded_calls.length === 0) {
    html += '<div class="empty-state">No delivery-degraded events.</div>';
  } else {
    html += '<table><thead><tr><th>Time</th><th>Building</th><th>Description</th></tr></thead><tbody>';
    for (const degradedCall of data.degraded_calls) {
      html += `<tr>
        <td style="white-space:nowrap;">${fmtDateTime(degradedCall.created_at)}</td>
        <td>${esc(degradedCall.building_name || '—')}</td>
        <td>${esc(degradedCall.description || '—')}</td>
      </tr>`;
    }
    html += '</tbody></table>';
  }

  container.innerHTML = html;
}