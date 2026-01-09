# SmartSocket Server

High-performance WebSocket server for real-time applications with built-in compression, encryption, and enterprise features.

**Version**: 1.0.0  
**Status**: Production Ready

---

## Features

✅ **High Performance** - <1ms message processing  
✅ **Binary Protocol** - DEFLATE compression built-in  
✅ **Namespace Support** - Logical event isolation  
✅ **Acknowledgments** - Request/response patterns  
✅ **Encryption** - Optional AES encryption  
✅ **Rate Limiting** - Built-in DDoS protection  
✅ **Connection Pooling** - Optimized resource usage  
✅ **Enterprise Ready** - Production-grade features  

---

## Installation

```bash
npm install smartsocket
```

---

## Quick Start

```javascript
const SmartSocket = require('smartsocket');

const server = new SmartSocket({
  port: 3000,
  enableEncryption: true,
  enableRateLimiting: true
});

// Handle connections
server.on('connected', (socket) => {
  console.log('Client connected:', socket.id);
  
  // Handle messages
  socket.on('hello', (data) => {
    console.log('Received:', data);
    socket.emit('response', { message: 'Hi back!' });
  });
});

// Handle disconnections
server.on('disconnected', (socket) => {
  console.log('Client disconnected:', socket.id);
});

server.start();
console.log('Server running on port 3000');
```

---

## API Reference

### Server Initialization

```javascript
const server = new SmartSocket({
  port: 3000,
  host: 'localhost',
  enableEncryption: true,
  enableRateLimiting: true,
  enableConnectionPooling: true,
  enableMessageCache: false,
  maxConnections: 10000,
  connectionTimeout: 30000,
  compressionThreshold: 1024,
  compressionLevel: 6,
  rateLimitWindow: 60000,
  rateLimitMaxRequests: 100
});
```

### Connection Handling

```javascript
// New connection
server.on('connected', (socket) => {
  console.log('Connected:', socket.id);
  socket.data.connectedAt = Date.now();
});

// Message received
socket.on('event-name', (data, ack) => {
  console.log('Event:', data);
  if (ack) ack({ received: true });  // Send acknowledgment
});

// Client disconnect
server.on('disconnected', (socket) => {
  console.log('Disconnected:', socket.id);
});

// Errors
server.on('error', (error, socket) => {
  console.error('Error:', error.message);
});
```

### Sending Messages

```javascript
// Send to specific client
socket.emit('event-name', { data: 'value' });

// Send to specific client with acknowledgment
socket.emit('event-name', { data: 'value' }, (ack) => {
  console.log('Client received:', ack);
});

// Broadcast to all clients
server.emit('event-name', { data: 'value' });

// Send to specific client by ID
server.to(socketId).emit('event-name', { data: 'value' });
```

### Namespaces

```javascript
const chatNS = server.namespace('/chat');
const gameNS = server.namespace('/game');

chatNS.on('message', (socket, data) => {
  console.log('Chat message:', data);
  chatNS.emit('message', data);  // Broadcast to /chat namespace
});

gameNS.on('move', (socket, data) => {
  console.log('Game move:', data);
  gameNS.emit('move', data);  // Broadcast to /game namespace
});
```

### Server Methods

```javascript
// Start server
server.start();

// Stop server
server.stop();

// Get server statistics
const stats = server.getStats();
// {
//   connections: 150,
//   memoryUsage: '45MB',
//   uptime: 3600000,
//   messagesPerSecond: 1250
// }

// Check if socket is connected
server.isConnected(socketId);

// Disconnect specific client
socket.disconnect();
```

---

## Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `port` | Number | 3000 | Server port |
| `host` | String | 'localhost' | Server host |
| `enableEncryption` | Boolean | true | Enable encryption |
| `enableRateLimiting` | Boolean | true | Enable rate limiting |
| `enableConnectionPooling` | Boolean | true | Enable pooling |
| `enableMessageCache` | Boolean | false | Cache messages |
| `maxConnections` | Number | 10000 | Max connections |
| `connectionTimeout` | Number | 30000 | Timeout (ms) |
| `compressionThreshold` | Number | 1024 | Compress >1KB |
| `compressionLevel` | Number | 6 | Compression (1-9) |
| `rateLimitWindow` | Number | 60000 | Rate limit window |
| `rateLimitMaxRequests` | Number | 100 | Max requests/window |

---

## Examples

### Chat Server

```javascript
const server = new SmartSocket({ port: 3000 });

const chatNS = server.namespace('/chat');

chatNS.on('join', (socket, data, ack) => {
  socket.data.username = data.username;
  chatNS.emit('user-joined', {
    username: data.username,
    id: socket.id
  });
  ack({ joined: true });
});

chatNS.on('message', (socket, data, ack) => {
  chatNS.emit('message', {
    from: socket.data.username,
    text: data.text,
    timestamp: Date.now()
  });
  ack({ sent: true });
});

server.start();
```

### Authentication

```javascript
const server = new SmartSocket({ port: 3000 });

server.on('connected', (socket) => {
  // Require authentication
  socket.requireAuth = true;
});

socket.on('auth', (data, ack) => {
  if (isValidCredentials(data)) {
    socket.data.userId = data.userId;
    socket.data.authenticated = true;
    ack({ success: true });
  } else {
    ack({ success: false, error: 'Invalid credentials' });
    socket.disconnect();
  }
});

socket.on('protected-event', (data, ack) => {
  if (!socket.data.authenticated) {
    ack({ error: 'Not authenticated' });
    return;
  }
  // Handle event
});
```

### Real-Time Notifications

```javascript
const server = new SmartSocket({ port: 3000 });
const notifyNS = server.namespace('/notifications');

// Notify specific user
function notifyUser(userId, message) {
  notifyNS.to(userId).emit('notification', {
    message,
    timestamp: Date.now()
  });
}

// Notify all users
function notifyAll(message) {
  notifyNS.emit('notification', {
    message,
    timestamp: Date.now()
  });
}

// Notify with acknowledgment
function notifyAndConfirm(userId, message, callback) {
  notifyNS.to(userId).emit('notification', 
    { message, timestamp: Date.now() },
    callback
  );
}
```

---

## Performance Tuning

### Connection Pooling

```javascript
const server = new SmartSocket({
  enableConnectionPooling: true,
  maxConnections: 10000
});
```

**Benefits**: 40% reduction in memory usage, faster connection setup

### Message Compression

```javascript
const server = new SmartSocket({
  compressionThreshold: 512,   // Compress all >512 bytes
  compressionLevel: 9          // Maximum compression
});
```

**Benefits**: 40-80% bandwidth reduction

### Rate Limiting

```javascript
const server = new SmartSocket({
  enableRateLimiting: true,
  rateLimitWindow: 60000,
  rateLimitMaxRequests: 1000
});
```

**Benefits**: DDoS protection, fair resource sharing

---

## Deployment

### Using PM2

```bash
npm install -g pm2
pm2 start smartsocket/index.js --name "smartsocket"
pm2 save
```

### Docker

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY smartsocket/ ./
RUN npm install --production
EXPOSE 3000
CMD ["npm", "start"]
```

### Environment Variables

```bash
PORT=3000
HOST=0.0.0.0
ENABLE_ENCRYPTION=true
ENABLE_RATE_LIMITING=true
MAX_CONNECTIONS=10000
```

---

## Monitoring

### Server Statistics

```javascript
setInterval(() => {
  const stats = server.getStats();
  console.log('Connections:', stats.connections);
  console.log('Memory:', stats.memoryUsage);
  console.log('Messages/sec:', stats.messagesPerSecond);
}, 10000);
```

### PM2 Monitoring

```bash
pm2 monit
pm2 logs smartsocket
```

---

## Security Best Practices

1. **Enable Encryption**
```javascript
const server = new SmartSocket({
  enableEncryption: true
});
```

2. **Enable Rate Limiting**
```javascript
const server = new SmartSocket({
  enableRateLimiting: true,
  rateLimitMaxRequests: 100
});
```

3. **Validate Input**
```javascript
socket.on('event', (data, ack) => {
  if (!isValidData(data)) {
    ack({ error: 'Invalid data' });
    return;
  }
  // Process event
});
```

4. **Authenticate Clients**
```javascript
socket.on('auth', (credentials, ack) => {
  if (verifyCredentials(credentials)) {
    socket.data.authenticated = true;
    ack({ success: true });
  } else {
    socket.disconnect();
  }
});
```

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| High memory usage | Enable connection pooling |
| Slow messages | Check compression settings |
| Too many connections | Implement rate limiting |
| Failed connections | Check firewall, enable encryption |

---

## Related Resources

- **Client Library**: [smartsocket-client](../smartsocket-client/)
- **Documentation Hub**: [smartsocket-docs](../smartsocket-docs/)
- **Main Docs**: [../README.md](../README.md)
- **Deployment Guide**: [../DEPLOYMENT.md](../DEPLOYMENT.md)
- **Advanced Features**: [../SMARTSOCKET_FEATURES.md](../SMARTSOCKET_FEATURES.md)

---

## License

MIT License - See [LICENSE](../LICENSE)

---

**Ready to build real-time applications?** Start with the [Quick Start](#quick-start) section above! 🚀
