import { randomUUID } from 'node:crypto';
import { meets } from './access.js';
import { notBefore } from './calendar.js';
import {
  KINDS,
  MAX_LINK,
  MAX_TITLE,
  isEventKind,
  type EntityType,
  type EventKind,
  type Severity,
  SEVERITIES,
} from './catalog.js';
import { NotificationError } from './errors.js';
import type { EntityVisibility, NotificationStore, RecipientDirectory } from './ports.js';
import { defaultRule } from './rules.js';
import type { NewDelivery, NewNotification } from './types.js';

/** A fact that deserves a notice, as the sources (outbox events and scans) describe it. */
export interface NotificationEvent {
  readonly tenantId: string;
  readonly kind: EventKind;
  readonly entityType: EntityType;
  readonly entityId: string;
  readonly title: string;
  readonly link: string;
  readonly severity: Severity;
  /** What makes the cycle of this notice: the due date of an entity, or the id of the alert. */
  readonly dateVersion: string;
  readonly threshold: string;
  /** Candidates, before they are revalidated. Identity subjects, not `user-` ids. */
  readonly recipients: readonly string[];
}

export interface IngestSummary {
  readonly created: number;
  readonly duplicates: number;
  /** Candidates that were dropped: not a member, no right, no longer see the entity or switched everything off. */
  readonly skipped: number;
}

const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,39}$/;
const FOLLOWABLE: readonly EntityType[] = ['vehicle', 'incident'];

export interface IngestDeps {
  readonly store: NotificationStore;
  readonly directory: RecipientDirectory;
  readonly visibility: EntityVisibility;
  readonly now: () => Date;
  readonly newId?: () => string;
}

function assertValid(event: NotificationEvent): void {
  const bad = (field: string): never => {
    throw new NotificationError('invalid_input', field);
  };
  if (!OPAQUE.test(event.tenantId)) bad('tenantId');
  if (!isEventKind(event.kind)) bad('kind');
  if (!OPAQUE.test(event.entityId)) bad('entityId');
  if (event.title.trim() === '' || event.title.length > MAX_TITLE) bad('title');
  if (!/^\/[^\s/]/.test(event.link) || event.link.length > MAX_LINK) bad('link');
  if (!(SEVERITIES as readonly string[]).includes(event.severity)) bad('severity');
  if (!VERSION.test(event.dateVersion)) bad('dateVersion');
  if (!VERSION.test(event.threshold)) bad('threshold');
  if (event.recipients.some((recipient) => !OPAQUE.test(recipient))) bad('recipients');
}

/**
 * Turns an event into notices. Each candidate is revalidated now (active member, the right the kind
 * needs, still sees the entity), the person's choices and the company's rule decide the channels,
 * and the unique key `(kind, entity, date version, threshold, recipient)` makes a repeated scan or
 * a retried event write nothing more. It never touches the command that caused the event.
 */
export class NotificationIngest {
  private readonly newId: () => string;
  public constructor(private readonly deps: IngestDeps) {
    this.newId = deps.newId ?? randomUUID;
  }

  public async ingest(event: NotificationEvent): Promise<IngestSummary> {
    assertValid(event);
    const { store, directory, visibility } = this.deps;
    const spec = KINDS[event.kind];
    const followers =
      spec.followers !== null && spec.followers === event.entityType
        ? await store.subscribersOf(event.tenantId, spec.followers, event.entityId)
        : [];
    const candidates = [...new Set([...event.recipients, ...followers])].sort();
    const rule = (await store.rule(event.tenantId)) ?? defaultRule();
    const now = this.deps.now();
    let zone: string | null = null;
    let created = 0;
    let duplicates = 0;
    let skipped = 0;
    for (const recipientId of candidates) {
      const access = await directory.access(event.tenantId, recipientId);
      if (
        !access ||
        !meets(access, spec.requires) ||
        (FOLLOWABLE.includes(event.entityType) &&
          !(await visibility.visible(event.tenantId, access, event.entityType, event.entityId)))
      ) {
        skipped += 1;
        continue;
      }
      const preference = (await store.preferences(event.tenantId, recipientId)).find(
        (item) => item.eventKind === event.kind,
      );
      const inApp = spec.mandatory || (preference?.inApp ?? true);
      const email =
        spec.email &&
        rule.emailKinds.includes(event.kind) &&
        (spec.mandatory || (preference?.email ?? true));
      if (!inApp && !email) {
        skipped += 1;
        continue;
      }
      const deliveries: NewDelivery[] = [];
      if (inApp) deliveries.push({ channel: 'in_app', status: 'sent', nextAttemptAt: null });
      if (email) {
        zone ??= rule.quietHours ? (await directory.company(event.tenantId)).timeZone : 'UTC';
        deliveries.push({
          channel: 'email',
          status: 'pending',
          nextAttemptAt: notBefore(now, zone, rule.quietHours).toISOString(),
        });
      }
      const notification: NewNotification = {
        id: this.newId(),
        tenantId: event.tenantId,
        recipientId,
        eventKind: event.kind,
        entityType: event.entityType,
        entityId: event.entityId,
        title: event.title,
        link: event.link,
        severity: event.severity,
        createdAt: now.toISOString(),
        inApp,
        dateVersion: event.dateVersion,
        threshold: event.threshold,
      };
      if (await store.create(notification, deliveries)) created += 1;
      else duplicates += 1;
    }
    return { created, duplicates, skipped };
  }
}
