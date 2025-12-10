const EventEmitter = require('events');

const conversationEvents = new EventEmitter();
conversationEvents.setMaxListeners(50);

const REALTIME_EVENTS = {
  MESSAGE_CREATED: 'conversation:message.created',
  UPSERTED: 'conversation:upserted',
  QUEUE_UPDATED: 'conversation:queue.updated'
};

module.exports = {
  conversationEvents,
  REALTIME_EVENTS
};
