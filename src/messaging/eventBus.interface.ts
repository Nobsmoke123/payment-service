import type { DomainEvent } from './events';

export type EventHandler<T = unknown> = (event: DomainEvent<T>) => Promise<void> | void;

export interface EventBus {
  publish<T>(event: DomainEvent<T>): Promise<void>;
  subscribe<T>(eventType: string, handler: EventHandler<T>): Promise<void>;
  close(): Promise<void>;
  drain?(): Promise<void>;
}
