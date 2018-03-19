const twilio = require('twilio');
const urljoin = require('url-join');
const kebabCase = require('lodash.kebabcase');

const { AccessToken } = twilio.jwt;
const { SyncGrant } = AccessToken;

const { getIdentityFromAddress } = require('../utils/identity');

const {
  TWILIO_API_KEY,
  TWILIO_API_SECRET,
  TWILIO_ACCOUNT_SID,
  TWILIO_NOTIFY_SERVICE,
  TWILIO_SYNC_SERVICE,
  TWILIO_MESSAGING_SERVICE,
} = process.env;

const {
  SYNC_NAMES,
  DEFAULT_CONFIGURATION,
  DEFAULT_EVENT_CONFIGURATION,
  SEGMENTS,
  TAGS,
} = require('../../shared/consts');

const restClient = twilio(TWILIO_API_KEY, TWILIO_API_SECRET, {
  accountSid: TWILIO_ACCOUNT_SID,
});

const syncClient = restClient.sync.services(TWILIO_SYNC_SERVICE);
const notifyClient = restClient.notify.services(TWILIO_NOTIFY_SERVICE);
const messagingClient = restClient.messaging.services(TWILIO_MESSAGING_SERVICE);

const orderQueueList = eventId =>
  syncClient.syncLists(SYNC_NAMES.ORDER_QUEUE + eventId);
const configurationDoc = syncClient.documents(SYNC_NAMES.CONFIGURATION);
const customersMap = syncClient.syncMaps(SYNC_NAMES.CUSTOMERS);
const allOrdersList = eventId =>
  syncClient.syncLists(SYNC_NAMES.ALL_ORDERS + eventId);

async function registerAddress(address, bindingType) {
  const identity = getIdentityFromAddress(address);
  const endpoint = `${identity}:${bindingType}`;
  const tag = [TAGS.INTERACTED];
  await notifyClient.bindings.create({
    identity,
    address,
    endpoint,
    bindingType,
    tag,
  });
  return identity;
}

async function sendMessage(identity, body) {
  const notification = await notifyClient.notifications.create({
    identity,
    body,
  });
  return notification;
}

async function sendMessageToAll(body) {
  const notification = await notifyClient.notifications.create({
    tag: TAGS.ALL,
    body,
  });
  return notification;
}

async function registerOpenOrder(identity) {
  const membership = await notifyClient
    .users(identity)
    .segmentMemberships.create({
      segment: SEGMENTS.OPEN_ORDER,
    });
  return membership;
}

async function deregisterOpenOrder(identity) {
  await notifyClient
    .users(identity)
    .segmentMemberships(SEGMENTS.OPEN_ORDER)
    .remove();
  return true;
}

async function sendMessageToAllOpenOrders(body) {
  const notification = await notifyClient.notifications.create({
    segment: SEGMENTS.OPEN_ORDER,
  });
  return notification;
}

async function setup(baseUrl) {
  await configureWebhookUrls(baseUrl);
  await createResources();
  return setPermissions();
}

async function configureWebhookUrls(baseUrl) {
  await messagingClient.update({
    inboundRequestUrl: urljoin(baseUrl, '/api/webhook/incoming'),
  });
  await syncClient.update({
    webhookUrl: urljoin(baseUrl, '/api/webhook/sync'),
  });
  return true;
}

async function loadConnectedPhoneNumbers() {
  const phoneNumbers = await messagingClient.phoneNumbers.list();
  const connectedPhoneNumbers = phoneNumbers.map(p => p.phoneNumber).join(', ');
  return connectedPhoneNumbers;
}

function createToken(user) {
  const syncGrant = new SyncGrant({
    serviceSid: TWILIO_SYNC_SERVICE,
  });

  const token = new AccessToken(
    TWILIO_ACCOUNT_SID,
    TWILIO_API_KEY,
    TWILIO_API_SECRET
  );
  token.addGrant(syncGrant);
  token.identity = user;
  return token.toJwt();
}

async function setOrderQueuePermission(orderQueueName) {
  const updateOrderQueuePermissions = syncClient
    .syncLists(orderQueueName)
    .syncListPermissions('barista')
    .update({ read: 'true', write: 'true', manage: 'false' });

  const updateOrderQueuePermissionsForAdmin = syncClient
    .syncLists(orderQueueName)
    .syncListPermissions('admin')
    .update({ read: 'true', write: 'true', manage: 'false' });

  return Promise.all([
    updateOrderQueuePermissions,
    updateOrderQueuePermissionsForAdmin,
  ]);
}

async function setAllOrdersListPermission(allOrdersListName) {
  const updateAllOrdersPermissionsForAdmin = syncClient
    .syncLists(allOrdersListName)
    .syncListPermissions('admin')
    .update({ read: 'true', write: 'true', manage: 'false' });

  const updateAllOrdersPermissionsForBarista = syncClient
    .syncLists(allOrdersListName)
    .syncListPermissions('barista')
    .update({ read: 'true', write: 'false', manage: 'false' });

  const updateAllOrdersPermissionsForDashboard = syncClient
    .syncLists(allOrdersListName)
    .syncListPermissions('dashboard')
    .update({ read: 'true', write: 'false', manage: 'false' });

  return Promise.all([
    updateAllOrdersPermissionsForAdmin,
    updateAllOrdersPermissionsForBarista,
    updateAllOrdersPermissionsForDashboard,
  ]);
}

async function setConfigurationPermissions(configName) {
  const updateConfigurationPermissionsForAdmin = syncClient
    .documents(configName)
    .documentPermissions('admin')
    .update({ read: 'true', write: 'true', manage: 'false' });

  return Promise.all([updateConfigurationPermissionsForAdmin]);
}

async function setPermissions() {
  const updateConfigurationPermissionsForAdmin = syncClient
    .documents(SYNC_NAMES.CONFIGURATION)
    .documentPermissions('admin')
    .update({
      read: 'true',
      write: 'true',
      manage: 'false',
    });

  const updateCustomerPermissionsForAdmin = syncClient
    .syncMaps(SYNC_NAMES.CUSTOMERS)
    .syncMapPermissions('admin')
    .update({
      read: 'true',
      write: 'true',
      manage: 'false',
    });

  return Promise.all([
    updateConfigurationPermissionsForAdmin,
    updateCustomerPermissionsForAdmin,
  ]);
}

const createConfigurationDoc = function() {
  return createIfNotExists(
    syncClient.documents,
    SYNC_NAMES.CONFIGURATION,
    DEFAULT_CONFIGURATION
  );
};
async function createOrderQueue(eventId) {
  const name = SYNC_NAMES.ORDER_QUEUE + eventId;
  return resetList(name);
}
const createCustomerMap = function() {
  return createIfNotExists(syncClient.syncMaps, SYNC_NAMES.CUSTOMERS);
};
async function createAllOrdersList(eventId) {
  const name = SYNC_NAMES.ALL_ORDERS + eventId;
  return resetList(name);
}

async function createResources() {
  return Promise.all([createConfigurationDoc(), createCustomerMap()]);
}

async function createIfNotExists(resource, name, data) {
  const argument = {
    uniqueName: name,
  };
  if (data) {
    argument.data = data;
  }
  try {
    return await resource(name).fetch();
  } catch (err) {
    return await resource.create(argument);
  }
}

async function resetAllLists(baseName) {
  const listNames = (await syncClient.syncLists.list())
    .map(list => list.uniqueName)
    .filter(name => name.startsWith(baseName));
  const listPromises = listNames.map(resetList);
  return Promise.all(listPromises);
}

async function resetList(name) {
  try {
    await syncClient.syncLists(name).remove();
  } catch (err) {
    // noop
  }
  await createIfNotExists(syncClient.syncLists, name);
  if (name.startsWith(SYNC_NAMES.ORDER_QUEUE)) {
    setOrderQueuePermission(name);
  } else if (name.startsWith(SYNC_NAMES.ALL_ORDERS)) {
    setAllOrdersListPermission(name);
  }
  return true;
}

async function resetMap(name) {
  await syncClient.syncMaps(name).remove();
  await createIfNotExists(syncClient.syncMaps, name);
}

async function resetNotify() {
  const users = await notifyClient.users.list();
  const deleteUsers = users.map(async ({ sid }) => {
    const bindings = await notifyClient.users(sid).bindings.list();
    const deleteBindings = bindings.map(async b =>
      notifyClient.bindings(b.sid).remove()
    );
    await Promise.all(deleteBindings);
    return notifyClient.users(sid).remove();
  });
  return Promise.all(deleteUsers);
}

function getEventConfigName(slug) {
  return SYNC_NAMES.EVENT_CONFIG + slug;
}

async function createEventConfiguration(eventName, customData) {
  const slug = kebabCase(eventName);
  const data = Object.assign(
    {},
    DEFAULT_EVENT_CONFIGURATION,
    {
      eventName,
      slug,
    },
    customData
  );
  const name = getEventConfigName(slug);
  const createResult = await createIfNotExists(
    syncClient.documents,
    name,
    data
  );
  await syncClient
    .documents(name)
    .documentPermissions('admin')
    .update({
      read: 'true',
      write: 'true',
      manage: 'false',
    });
  return createResult;
}

async function listAllEvents() {
  const documents = await syncClient.documents.list();
  const events = documents
    .map(d => d.uniqueName)
    .filter(name => name.indexOf(SYNC_NAMES.EVENT_CONFIG) === 0);
  return events;
}

async function fetchEventConfigurations() {
  const events = await listAllEvents();
  const eventDataPromises = events.map(async name => {
    const { data } = await syncClient.documents(name).fetch();
    return data;
  });
  return Promise.all(eventDataPromises);
}

function getEventConfigDoc(slug) {
  return syncClient.documents(getEventConfigName(slug));
}

module.exports = {
  SYNC_NAMES,
  restClient,
  notifyClient,
  syncClient,
  sendMessage,
  registerAddress,
  messagingClient,
  orderQueueList,
  configurationDoc,
  customersMap,
  allOrdersList,
  setup,
  createToken,
  createConfigurationDoc,
  loadConnectedPhoneNumbers,
  sendMessageToAll,
  sendMessageToAllOpenOrders,
  registerOpenOrder,
  deregisterOpenOrder,
  resetList,
  setPermissions,
  resetMap,
  resetNotify,
  fetchEventConfigurations,
  getEventConfigDoc,
  createEventConfiguration,
  listAllEvents,
  resetAllLists,
  createAllOrdersList,
  createOrderQueue,
};
