/**
 * SmartSocket Server - Production-Grade WebSocket Server
 * Complete TypeScript type definitions
 */

// ============================================
// Configuration & Options
// ============================================

export interface SmartSocketOptions {
  // Feature flags
  enableMiddleware?: boolean;
  enableNamespaces?: boolean;
  enableAcknowledgments?: boolean;
  enableErrorHandling?: boolean;
  
  // Connection options
  maxCapacity?: number;
  refillRate?: number;
  cpuThreshold?: number;
  memoryThreshold?: number;
  maxStreams?: number;
  poolSize?: number;
  bufferSize?: number;
  
  // Logging
  verbose?: boolean;
  
  // Acknowledgment options
  ackTimeout?: number;
  maxPendingAcks?: number;
  retryAttempts?: number;
  retryDelay?: number;
}

// ============================================
// Middleware & Handlers
// ============================================

export type NextFunction = (error?: Error | string) => void;
export type MiddlewareFunction = (
  socket: SmartSocket,
  event: string,
  data: any,
  next: NextFunction,
  context?: any
) => void | Promise<void>;

export type ErrorMiddlewareFunction = (
  socket: SmartSocket,
  error: Error,
  next: NextFunction,
  context?: any
) => void | Promise<void>;

export type ErrorHandlerFunction = (socket: SmartSocket, error: ErrorInfo) => void;

export interface ErrorInfo {
  message: string;
  code: string;
  timestamp: number;
  socketId: string | null;
  event?: string;
  [key: string]: any;
}

// ============================================
// Socket & Events
// ============================================

export type SocketEventHandler = (socket: SmartSocket, data?: any, ack?: (response: any) => void) => void;

export interface SmartSocket {
  id: string;
  namespace?: string;
  rooms: Set<string>;
  handlers: Map<string, SocketEventHandler>;
  data: Map<string, any>;
  emit(event: string, data: any): void;
  on(event: string, handler: SocketEventHandler): void;
  join(room: string): void;
  leave(room: string): void;
  disconnect(): void;
  broadcast(event: string, data: any): void;
}

// ============================================
// Middleware Manager
// ============================================

export interface MiddlewareMetrics {
  processed: number;
  errors: number;
  totalTime: number;
  slowestTime: number;
  averageTime: number;
  errorRate: string;
}

export class MiddlewareManager {
  useRequest(handler: MiddlewareFunction): this;
  useResponse(handler: MiddlewareFunction): this;
  useError(handler: ErrorMiddlewareFunction): this;
  use(handler: MiddlewareFunction): this;
  executeRequest(socket: SmartSocket, event: string, data: any, context?: any): Promise<{
    allowed: boolean;
    duration: number;
    error?: string;
  }>;
  executeResponse(socket: SmartSocket, event: string, data: any, context?: any): Promise<{
    allowed: boolean;
    duration: number;
    error?: string;
  }>;
  executeError(socket: SmartSocket, error: Error, context?: any): Promise<void>;
  getMetrics(): MiddlewareMetrics;
  clear(): void;
}

export namespace BuiltinMiddleware {
  function auth(requiredRoles?: string[]): MiddlewareFunction;
  function rateLimit(maxEvents: number, windowMs: number): MiddlewareFunction;
  function validate(schema: { required?: string[] }): MiddlewareFunction;
  function logger(level?: string): MiddlewareFunction;
  function transform(transformFn: (data: any) => any): MiddlewareFunction;
}

// ============================================
// Namespace Manager & Namespace
// ============================================

export interface NamespaceStats {
  socketCount: number;
  roomCount: number;
  handlerCount: number;
  middlewareCount: number;
}

export class Namespace {
  name: string;
  sockets: Set<SmartSocket>;
  rooms: Map<string, Set<SmartSocket>>;
  handlers: Map<string, SocketEventHandler>;
  middleware: MiddlewareFunction[];
  data: Map<string, any>;
  
  on(event: string, handler: SocketEventHandler): this;
  use(middleware: MiddlewareFunction): this;
  emit(event: string, data: any): this;
  broadcast(sender: SmartSocket, event: string, data: any): this;
  to(room: string): { emit(event: string, data: any): void };
  addSocket(socket: SmartSocket): void;
  removeSocket(socket: SmartSocket): void;
  getSockets(): SmartSocket[];
  getSocketCount(): number;
  getMiddleware(): MiddlewareFunction[];
  clear(): void;
}

export class NamespaceManager {
  constructor(server: SmartSocketServer);
  namespace(name: string): Namespace;
  getDefault(): Namespace;
  getAll(): Namespace[];
  findSocket(socketId: string): { socket: SmartSocket; namespace: Namespace } | null;
  findAllSockets(predicate: (socket: SmartSocket) => boolean): Array<{ socket: SmartSocket; namespace: Namespace }>;
  deleteNamespace(name: string): boolean;
  getStats(): Record<string, NamespaceStats>;
  clear(): void;
}

// ============================================
// Acknowledgment Manager
// ============================================

export interface AcknowledgmentMetrics {
  sent: number;
  received: number;
  timeout: number;
  failed: number;
  pending: number;
  successRate: string;
}

export class AcknowledgmentManager {
  constructor(options?: SmartSocketOptions);
  createAck(): Promise<any>;
  resolveAck(ackId: number, data: any): boolean;
  rejectAck(ackId: number, error?: string): boolean;
  getPending(): { count: number; ackIds: number[] };
  getMetrics(): AcknowledgmentMetrics;
  clear(): void;
  cleanup(): number;
}

// ============================================
// Error Handler
// ============================================

export interface ErrorMetrics {
  total: number;
  handled: number;
  unhandled: number;
  handledRate: string;
}

export class ErrorHandler {
  constructor(server: SmartSocketServer);
  on(event: string, handler: ErrorHandlerFunction): this;
  onError(handler: ErrorHandlerFunction): this;
  emitError(socket: SmartSocket, error: Error, context?: any): void;
  getMetrics(): ErrorMetrics;
}

// ============================================
// SmartSocket API
// ============================================

export interface PulseControl {
  pulseId: string;
  stop(): void;
}

export interface SyncControl {
  syncId: string;
  namespace: string;
  update(newState: any): void;
}

export class SmartSocketAPI {
  constructor(server: SmartSocketServer);
  target(socketId: string, event: string, data: any): boolean;
  scatter(socketIds: string[], event: string, data: any): string[];
  cast(event: string, data: any): number;
  pulse(event: string, data: any, interval?: number): PulseControl;
  sync(namespace: string, state: any): SyncControl;
  query(socketId: string, event: string, timeout?: number): Promise<any>;
  rpc(socketId: string, functionName: string, args?: any, timeout?: number): Promise<any>;
  filter(predicate: (socket: SmartSocket) => boolean, event: string, data: any): number;
  group(groupName: string, event: string, data: any): number;
}

// ============================================
// Main SmartSocket Server
// ============================================

export type ServerEventHandler = (socket: SmartSocket, data?: any, ack?: (response: any) => void) => void;

export class SmartSocketServer {
  constructor(port?: number, options?: SmartSocketOptions);
  
  port: number;
  options: SmartSocketOptions;
  sockets: Set<SmartSocket>;
  rooms: Map<string, Set<SmartSocket>>;
  handlers: Map<string, ServerEventHandler>;
  middleware: MiddlewareManager | null;
  namespaceManager: NamespaceManager | null;
  ackManager: AcknowledgmentManager | null;
  errorHandler: ErrorHandler | null;
  api: SmartSocketAPI | null;
  
  // Server lifecycle
  listen(callback?: () => void): this;
  close(): void;
  
  // Event handlers
  on(event: string, handler: ServerEventHandler): this;
  off(event: string): this;
  
  // Broadcasting
  emit(event: string, data: any): this;
  broadcast(sender: SmartSocket, event: string, data: any): this;
  to(room: string): { emit(event: string, data: any): void };
  
  // Middleware (if enabled)
  use(handler: MiddlewareFunction): this;
  useRequest(handler: MiddlewareFunction): this;
  useResponse(handler: MiddlewareFunction): this;
  useError(handler: ErrorMiddlewareFunction): this;
  
  // Namespaces (if enabled)
  namespace(name: string): Namespace;
  
  // Error handling (if enabled)
  onError(handler: ErrorHandlerFunction): this;
  
  // Features & Stats
  getFeatures(): {
    middleware: string;
    namespaces: string;
    acknowledgments: string;
    errorHandling: string;
  };
  getOptimizationStats(): any;
  startMonitoring(interval?: number): void;
  stopMonitoring(): void;
}

// ============================================
// Binary Encoder
// ============================================

export interface BinaryEncoderStatic {
  encode(event: string, data: any): Promise<any>;
  decode(data: any): Promise<any>;
}

export var BinaryEncoder: BinaryEncoderStatic;

// ============================================
// Factory Function
// ============================================

export default function smartsocket(port?: number, options?: SmartSocketOptions): SmartSocketServer;

// ============================================
// Named Exports
// ============================================

export {
  SmartSocketServer,
  SmartSocket,
  MiddlewareManager,
  NamespaceManager,
  Namespace,
  AcknowledgmentManager,
  ErrorHandler,
  SmartSocketAPI,
  BinaryEncoder
};
