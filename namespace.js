/**
 * SmartSocket Namespace System - Separate concerns and organize code
 * 
 * Usage:
 * const chat = server.namespace('/chat');
 * chat.on('send-message', (socket, data) => { ... });
 * 
 * Client:
 * const chatSocket = new SmartSocketClient('ws://localhost:8080/chat');
 * chatSocket.emit('send-message', { text: 'Hello' });
 * 
 * Disable: Create server with { enableNamespaces: false }
 */

export class Namespace {
  constructor(name, server) {
    this.name = name;
    this.server = server;
    this.sockets = new Set();
    this.rooms = new Map();
    this.handlers = {};
    this.middleware = [];
    this.data = {};
  }

  /**
   * Register event handler for this namespace
   */
  on(event, handler) {
    if (typeof handler !== 'function') {
      throw new TypeError('Handler must be a function');
    }
    this.handlers[event] = handler;
    return this;
  }

  /**
   * Register namespace-specific middleware
   */
  use(middleware) {
    if (typeof middleware !== 'function') {
      throw new TypeError('Middleware must be a function');
    }
    this.middleware.push(middleware);
    return this;
  }

  /**
   * Emit to all sockets in this namespace
   */
  emit(event, data) {
    this.sockets.forEach(socket => {
      socket.emit(event, data);
    });
    return this;
  }

  /**
   * Broadcast to all except sender
   */
  broadcast(sender, event, data) {
    this.sockets.forEach(socket => {
      if (socket.id !== sender.id) {
        socket.emit(event, data);
      }
    });
    return this;
  }

  /**
   * Emit to specific room within namespace
   */
  to(room) {
    return {
      emit: (event, data) => {
        if (this.rooms.has(room)) {
          this.rooms.get(room).forEach(socket => {
            socket.emit(event, data);
          });
        }
      }
    };
  }

  /**
   * Add socket to namespace
   */
  addSocket(socket) {
    if (!this.sockets.has(socket)) {
      this.sockets.add(socket);
      // Assign namespace to socket
      socket.namespace = this.name;
    }
  }

  /**
   * Remove socket from namespace
   */
  removeSocket(socket) {
    this.sockets.delete(socket);
    
    // Remove from all rooms in this namespace
    for (const [roomName, roomSockets] of this.rooms.entries()) {
      roomSockets.delete(socket);
      if (roomSockets.size === 0) {
        this.rooms.delete(roomName);
      }
    }
  }

  /**
   * Get all sockets in namespace
   */
  getSockets() {
    return Array.from(this.sockets);
  }

  /**
   * Get socket count
   */
  getSocketCount() {
    return this.sockets.size;
  }

  /**
   * Get middleware for this namespace
   */
  getMiddleware() {
    return [...this.middleware];
  }

  /**
   * Clear namespace
   */
  clear() {
    this.sockets.clear();
    this.rooms.clear();
    this.handlers = {};
    this.middleware = [];
    this.data = {};
  }
}

export class NamespaceManager {
  constructor(server) {
    this.server = server;
    this.namespaces = new Map();
    this.defaultNamespace = new Namespace('/', server);
    this.namespaces.set('/', this.defaultNamespace);
  }

  /**
   * Get or create namespace
   */
  namespace(name) {
    // Normalize namespace name
    if (!name.startsWith('/')) {
      name = '/' + name;
    }
    
    if (!this.namespaces.has(name)) {
      this.namespaces.set(name, new Namespace(name, this.server));
    }
    
    return this.namespaces.get(name);
  }

  /**
   * Get default namespace
   */
  getDefault() {
    return this.defaultNamespace;
  }

  /**
   * Get all namespaces
   */
  getAll() {
    return Array.from(this.namespaces.values());
  }

  /**
   * Find socket in any namespace
   */
  findSocket(socketId) {
    for (const namespace of this.namespaces.values()) {
      for (const socket of namespace.sockets) {
        if (socket.id === socketId) {
          return { socket, namespace };
        }
      }
    }
    return null;
  }

  /**
   * Find all sockets across all namespaces
   */
  findAllSockets(predicate) {
    const results = [];
    for (const namespace of this.namespaces.values()) {
      for (const socket of namespace.sockets) {
        if (predicate(socket)) {
          results.push({ socket, namespace });
        }
      }
    }
    return results;
  }

  /**
   * Delete namespace
   */
  deleteNamespace(name) {
    if (name === '/') {
      throw new Error('Cannot delete default namespace');
    }
    
    const namespace = this.namespaces.get(name);
    if (namespace) {
      namespace.clear();
      this.namespaces.delete(name);
      return true;
    }
    return false;
  }

  /**
   * Get statistics
   */
  getStats() {
    const stats = {};
    for (const [name, namespace] of this.namespaces.entries()) {
      stats[name] = {
        socketCount: namespace.getSocketCount(),
        roomCount: namespace.rooms.size,
        handlerCount: Object.keys(namespace.handlers).length,
        middlewareCount: namespace.middleware.length
      };
    }
    return stats;
  }

  /**
   * Clear all namespaces except default
   */
  clear() {
    for (const [name] of this.namespaces.entries()) {
      if (name !== '/') {
        this.deleteNamespace(name);
      }
    }
    this.defaultNamespace.clear();
  }
}

export default Namespace;
