const test = require('node:test');
const assert = require('node:assert/strict');

const signalingContract = require('../../../test/signalingContract');
const { createScenarioRunner } = require('./scenarioHarness');

test('scenario runner completes ring -> accept -> offer -> hangup across fake intercom and home clients', async () => {
  const runner = createScenarioRunner({
    uuidValues: ['connection-1', 'connection-2', 'call-1'],
  });

  try {
    const intercom = runner.createIntercom();
    const home = runner.createHome();

    await intercom.registerIntercom();
    await home.registerHome();
    await intercom.ring('apt-1');
    await runner.flushAsync(2);

    assert.deepEqual(home.lastMessage, signalingContract.serverToHome.ring({ callId: 'call-1' }));

    await home.accept({ callId: 'call-1', userId: 'user-1' });
    await runner.flushAsync(2);
    assert.deepEqual(intercom.lastMessage, signalingContract.serverToIntercom.accept({ callId: 'call-1' }));

    await home.offer();
    await runner.flushAsync();
    assert.deepEqual(intercom.lastMessage, signalingContract.serverToIntercom.offer());

    await home.hangup({ callId: 'call-1' });
    await runner.flushAsync(2);
    assert.deepEqual(intercom.lastMessage, signalingContract.serverToIntercom.hangup());
    assert.equal(runner.getActiveCall(), null);
  } finally {
    runner.dispose();
  }
});

test('scenario runner enforces first-accept-wins across two home clients', async () => {
  const runner = createScenarioRunner({
    uuidValues: ['connection-1', 'connection-2', 'connection-3', 'call-1'],
  });

  try {
    const intercom = runner.createIntercom();
    const homeOne = runner.createHome('home-1');
    const homeTwo = runner.createHome('home-2');

    await intercom.registerIntercom();
    await homeOne.registerHome();
    await homeTwo.registerHome();
    await intercom.ring('apt-1');
    await runner.flushAsync(2);

    await homeOne.accept({ callId: 'call-1', userId: 'user-1' });
    await runner.flushAsync(2);
    assert.deepEqual(intercom.lastMessage, signalingContract.serverToIntercom.accept({ callId: 'call-1' }));
    assert.deepEqual(homeTwo.lastMessage, signalingContract.serverToHome.callTaken({ callId: 'call-1' }));

    const acceptCountBefore = intercom.sentMessages.filter((message) => message.type === 'accept').length;
    await homeTwo.accept({ callId: 'call-1', userId: 'user-2' });
    await runner.flushAsync();
    const acceptCountAfter = intercom.sentMessages.filter((message) => message.type === 'accept').length;

    assert.equal(acceptCountAfter, acceptCountBefore);
    assert.deepEqual(homeTwo.lastMessage, signalingContract.serverToHome.callTaken({ callId: 'call-1' }));
  } finally {
    runner.dispose();
  }
});

test('scenario runner relays watch start and watch end cleanly', async () => {
  const runner = createScenarioRunner({
    uuidValues: ['connection-1', 'connection-2'],
  });

  try {
    const intercom = runner.createIntercom();
    const home = runner.createHome();

    await intercom.registerIntercom();
    await home.registerHome();
    await home.watch();
    await runner.flushAsync();

    assert.deepEqual(intercom.lastMessage, signalingContract.serverToIntercom.watch());
    const watchCall = runner.getActiveCall();
    assert.equal(watchCall.type, 'watch');

    await home.watchEnd();
    await runner.flushAsync();
    assert.deepEqual(intercom.lastMessage, signalingContract.serverToIntercom.watchEnd());
    assert.equal(runner.getActiveCall(), null);
  } finally {
    runner.dispose();
  }
});

test('scenario runner replays a pending ring to a late-joining home client', async () => {
  const runner = createScenarioRunner({
    uuidValues: ['connection-1', 'connection-2', 'call-1'],
  });

  try {
    const intercom = runner.createIntercom();
    const earlyHome = runner.createHome('home-1');

    await intercom.registerIntercom();
    await earlyHome.registerHome();
    await intercom.ring('apt-1');
    await runner.flushAsync(2);

    const lateHome = runner.createHome('home-2');
    await lateHome.registerHome();
    await runner.flushAsync(2);

    assert.deepEqual(lateHome.lastMessage, signalingContract.serverToHome.ring({ apartmentId: 'apt-1', buildingId: 'building-1', callId: 'call-1', lateJoin: true }));
    assert.equal(runner.getPendingRing()?.intercomDeviceId, 'intercom-1');
  } finally {
    runner.dispose();
  }
});

test('scenario runner sends call-taken to a late-joining home client after another resident accepts', async () => {
  const runner = createScenarioRunner({
    uuidValues: ['connection-1', 'connection-2', 'call-1', 'connection-3'],
  });

  try {
    const intercom = runner.createIntercom();
    const winningHome = runner.createHome('home-1');

    await intercom.registerIntercom();
    await winningHome.registerHome();
    await intercom.ring('apt-1');
    await runner.flushAsync(2);

    await winningHome.accept({ callId: 'call-1', userId: 'user-1' });
    await runner.flushAsync(2);

    const lateHome = runner.createHome('home-2');
    await lateHome.registerHome();
    await runner.flushAsync(2);

    assert.deepEqual(lateHome.lastMessage, signalingContract.serverToHome.callTaken({ callId: 'call-1' }));
  } finally {
    runner.dispose();
  }
});

test('scenario runner relays decline only after all connected home clients decline', async () => {
  const runner = createScenarioRunner({
    uuidValues: ['connection-1', 'connection-2', 'connection-3', 'call-1'],
  });

  try {
    const intercom = runner.createIntercom();
    const homeOne = runner.createHome('home-1');
    const homeTwo = runner.createHome('home-2');

    await intercom.registerIntercom();
    await homeOne.registerHome();
    await homeTwo.registerHome();
    await intercom.ring('apt-1');
    await runner.flushAsync(2);

    await homeOne.decline({ callId: 'call-1' });
    await runner.flushAsync(2);
    assert.equal(intercom.sentMessages.some((message) => message.type === 'decline'), false);
    assert.notEqual(runner.getActiveCall(), null);

    await homeTwo.decline({ callId: 'call-1' });
    await runner.flushAsync(2);
    assert.deepEqual(intercom.lastMessage, signalingContract.serverToIntercom.decline());
    assert.equal(runner.getActiveCall(), null);
    assert.equal(runner.getPendingRing(), null);
  } finally {
    runner.dispose();
  }
});

test('scenario runner relays open-door and clears the active call', async () => {
  const runner = createScenarioRunner({
    uuidValues: ['connection-1', 'connection-2', 'call-1'],
  });

  try {
    const intercom = runner.createIntercom();
    const home = runner.createHome();

    await intercom.registerIntercom();
    await home.registerHome();
    await intercom.ring('apt-1');
    await runner.flushAsync(2);
    await home.accept({ callId: 'call-1', userId: 'user-1' });
    await runner.flushAsync(2);

    await home.openDoor();
    await runner.flushAsync(2);

    assert.deepEqual(intercom.lastMessage, signalingContract.serverToIntercom.openDoor());
    assert.equal(runner.getActiveCall(), null);
    assert.equal(runner.getPendingRing(), null);
  } finally {
    runner.dispose();
  }
});

test('scenario runner displaces the previous watcher when another home starts watching', async () => {
  const runner = createScenarioRunner({
    uuidValues: ['connection-1', 'connection-2', 'connection-3'],
  });

  try {
    const intercom = runner.createIntercom();
    const firstHome = runner.createHome('home-1');
    const secondHome = runner.createHome('home-2');

    await intercom.registerIntercom();
    await firstHome.registerHome();
    await secondHome.registerHome();

    await firstHome.watch();
    await runner.flushAsync(2);
    assert.deepEqual(intercom.lastMessage, signalingContract.serverToIntercom.watch());

    await secondHome.watch();
    await runner.flushAsync(2);

    assert.deepEqual(firstHome.lastMessage, signalingContract.serverToHome.watchEnd());
    assert.deepEqual(intercom.sentMessages.slice(-2), [
      signalingContract.serverToIntercom.watchEnd(),
      signalingContract.serverToIntercom.watch(),
    ]);

    const watchCall = runner.getActiveCall();
    assert.equal(watchCall.type, 'watch');
    assert.equal(watchCall.acceptedWs, secondHome.ws);
  } finally {
    runner.dispose();
  }
});

test('scenario runner rejects watch requests while the intercom is already on a call', async () => {
  const runner = createScenarioRunner({
    uuidValues: ['connection-1', 'connection-2', 'connection-3', 'call-1'],
  });

  try {
    const intercom = runner.createIntercom();
    const homeInCall = runner.createHome('home-1');
    const watchRequester = runner.createHome('home-2');

    await intercom.registerIntercom();
    await homeInCall.registerHome();
    await watchRequester.registerHome();
    await intercom.ring('apt-1');
    await runner.flushAsync(2);
    await homeInCall.accept({ callId: 'call-1', userId: 'user-1' });
    await runner.flushAsync(2);

    await watchRequester.watch();
    await runner.flushAsync(2);

    assert.deepEqual(watchRequester.lastMessage, { type: 'error', message: 'Intercom is busy on a call' });
    assert.equal(intercom.sentMessages.some((message) => message.type === 'watch'), false);
    assert.equal(runner.getActiveCall()?.type, 'call');
  } finally {
    runner.dispose();
  }
});

test('scenario runner marks pending rings unanswered when timeout expires', async () => {
  const runner = createScenarioRunner({
    uuidValues: ['connection-1', 'connection-2', 'call-1'],
  });

  try {
    const intercom = runner.createIntercom();
    const home = runner.createHome();

    await intercom.registerIntercom();
    await home.registerHome();
    await intercom.ring('apt-1');
    await runner.flushAsync(2);

    const expired = await runner.triggerPendingRingExpiry('apt-1');
    await runner.flushAsync(2);

    assert.equal(expired, true);
    assert.equal(runner.getActiveCall(), null);
    assert.equal(runner.getPendingRing(), null);
  } finally {
    runner.dispose();
  }
});

test('scenario runner treats ringing-home disconnect as implicit decline and relays decline when all homes disconnected', async () => {
  const runner = createScenarioRunner({
    uuidValues: ['connection-1', 'connection-2', 'connection-3', 'call-1'],
  });

  try {
    const intercom = runner.createIntercom();
    const homeOne = runner.createHome('home-1');
    const homeTwo = runner.createHome('home-2');

    await intercom.registerIntercom();
    await homeOne.registerHome();
    await homeTwo.registerHome();
    await intercom.ring('apt-1');
    await runner.flushAsync(2);

    await homeOne.disconnect();
    await runner.flushAsync(2);
    assert.equal(intercom.sentMessages.some((message) => message.type === 'decline'), false);

    await homeTwo.disconnect();
    await runner.flushAsync(2);

    assert.deepEqual(intercom.lastMessage, signalingContract.serverToIntercom.decline());
    assert.equal(runner.getActiveCall(), null);
    assert.equal(runner.getPendingRing(), null);
  } finally {
    runner.dispose();
  }
});

test('scenario runner keeps accepted call active when a non-winning home disconnects', async () => {
  const runner = createScenarioRunner({
    uuidValues: ['connection-1', 'connection-2', 'connection-3', 'call-1'],
  });

  try {
    const intercom = runner.createIntercom();
    const winningHome = runner.createHome('home-1');
    const otherHome = runner.createHome('home-2');

    await intercom.registerIntercom();
    await winningHome.registerHome();
    await otherHome.registerHome();
    await intercom.ring('apt-1');
    await runner.flushAsync(2);

    await winningHome.accept({ callId: 'call-1', userId: 'user-1' });
    await runner.flushAsync(2);
    assert.deepEqual(intercom.lastMessage, signalingContract.serverToIntercom.accept({ callId: 'call-1' }));

    const hangupCountBefore = intercom.sentMessages.filter((message) => message.type === 'hangup').length;
    await otherHome.disconnect();
    await runner.flushAsync(2);

    const hangupCountAfter = intercom.sentMessages.filter((message) => message.type === 'hangup').length;
    assert.equal(hangupCountAfter, hangupCountBefore);
    assert.equal(runner.getActiveCall()?.acceptedWs, winningHome.ws);
  } finally {
    runner.dispose();
  }
});

test('scenario runner ends the accepted call and notifies the intercom when the winning home disconnects', async () => {
  const runner = createScenarioRunner({
    uuidValues: ['connection-1', 'connection-2', 'call-1'],
  });

  try {
    const intercom = runner.createIntercom();
    const winningHome = runner.createHome('home-1');

    await intercom.registerIntercom();
    await winningHome.registerHome();
    await intercom.ring('apt-1');
    await runner.flushAsync(2);

    await winningHome.accept({ callId: 'call-1', userId: 'user-1' });
    await runner.flushAsync(2);

    await winningHome.disconnect();
    await runner.flushAsync(2);

    assert.deepEqual(intercom.lastMessage, { type: 'peer-disconnected', role: 'home' });
    assert.equal(runner.getActiveCall(), null);
    assert.equal(runner.getPendingRing(), null);
  } finally {
    runner.dispose();
  }
});

test('scenario runner sends call-taken push fallback to offline apartment devices after another resident accepts', async () => {
  const runner = createScenarioRunner({
    uuidValues: ['connection-1', 'connection-2', 'call-1'],
    queryOptions: {
      callRows: [
        { token: 'voip-offline', token_type: 'voip' },
        { token: 'fcm-offline', token_type: 'fcm' },
      ],
    },
    isAPNsReady: true,
  });

  try {
    const intercom = runner.createIntercom();
    const home = runner.createHome();

    await intercom.registerIntercom();
    await home.registerHome();
    await intercom.ring('apt-1');
    await runner.flushAsync(2);

    await home.accept({ callId: 'call-1', userId: 'user-1' });
    await runner.flushAsync(4);

    assert.deepEqual(runner.getVoipPushCalls(), [
      ['voip-offline', 'call-taken', { type: 'call-taken', callId: 'call-1' }],
    ]);
    assert.deepEqual(runner.getFcmSendCalls(), [
      {
        token: 'fcm-offline',
        data: { type: 'call-taken', callId: 'call-1' },
        android: { priority: 'high' },
      },
    ]);
  } finally {
    runner.dispose();
  }
});

test('scenario runner deletes stale push tokens when call-taken push fallback reports invalid devices', async () => {
  const runner = createScenarioRunner({
    uuidValues: ['connection-1', 'connection-2', 'call-1'],
    queryOptions: {
      callRows: [
        { token: 'dead-voip', token_type: 'voip' },
        { token: 'dead-fcm', token_type: 'fcm' },
      ],
    },
    isAPNsReady: true,
    sendVoipPushImpl: async () => ({ success: false, reason: 'BadDeviceToken' }),
    fcmSendImpl: async () => {
      const err = new Error('gone');
      err.code = 'messaging/registration-token-not-registered';
      throw err;
    },
  });

  try {
    const intercom = runner.createIntercom();
    const home = runner.createHome();

    await intercom.registerIntercom();
    await home.registerHome();
    await intercom.ring('apt-1');
    await runner.flushAsync(2);

    await home.accept({ callId: 'call-1', userId: 'user-1' });
    await runner.flushAsync(6);

    assert.ok(runner.getDeleteCalls().some(({ params }) => params[0] === 'dead-voip'));
    assert.ok(runner.getDeleteCalls().some(({ params }) => params[0] === 'dead-fcm'));
  } finally {
    runner.dispose();
  }
});

test('scenario runner reconciles a prior HTTP accept from the same resident without relaying a duplicate accept', async () => {
  const runner = createScenarioRunner({
    uuidValues: ['connection-1', 'connection-2', 'call-1'],
  });

  try {
    const intercom = runner.createIntercom();
    const home = runner.createHome();

    await intercom.registerIntercom();
    await home.registerHome();
    await intercom.ring('apt-1');
    await runner.flushAsync(2);

    assert.equal(runner.seedHttpAccept('intercom-1', 'user-1'), true);

    await home.accept({ callId: 'call-1', userId: 'user-1' });
    await runner.flushAsync(2);

    const call = runner.getActiveCall();
    assert.equal(call.acceptedBy, 'connection-2');
    assert.equal(call.acceptedWs, home.ws);
    assert.equal(intercom.sentMessages.some((message) => message.type === 'accept'), false);
  } finally {
    runner.dispose();
  }
});