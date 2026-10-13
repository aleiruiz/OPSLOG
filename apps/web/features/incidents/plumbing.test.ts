import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BffClient } from '@opslog/contracts';
import { createIncidentPorts } from './ports';
import { canvasCompress } from './prepareFile';

describe('incident ports', () => {
  it('maps every port to its contract route with the right inputs', async () => {
    const seen: { id: string; input: Record<string, unknown> }[] = [];
    const client = {
      call: async (id: string, input?: Record<string, unknown>) => {
        seen.push({ id, input: input ?? {} });
        return id === 'vehicles.get'
          ? { ok: true, value: { version: 7 } }
          : { ok: true, value: null };
      },
    } as unknown as BffClient;
    const ports = createIncidentPorts(client);
    await ports.list();
    await ports.list({ limit: 50, status: 'draft' });
    await ports.get('i');
    await ports.create({ vehicleId: 'v', type: 'collision' }, 'key-1');
    await ports.update('i', { version: 1, description: 'x' });
    await ports.suggestions({ vehicleId: 'v', occurredAt: '2026-10-12T15:30:00.000Z' });
    await ports.timeline('i');
    await ports.nextSteps('i');
    await ports.transition('i', { command: 'report', version: 1 }, 'key-2');
    await ports.updateInsurance('i', { version: 1 });
    await ports.updateResolution('i', { version: 1 });
    await ports.thirdParties.list('i');
    await ports.thirdParties.create('i', { version: 1, kind: 'person' }, 'key-3');
    await ports.thirdParties.update('i', 'p', { version: 1 });
    await ports.thirdParties.remove('i', 'p', 3);
    await ports.evidence.list('i');
    await ports.evidence.upload(
      'i',
      {
        version: 1,
        category: 'photo',
        stage: 'on_site',
        name: 'a.jpg',
        contentType: 'image/jpeg',
        contentBase64: 'AA==',
      },
      'key-4',
    );
    await ports.evidence.detach('i', 'e', 4);
    await ports.evidence.content('i', 'e');
    expect(await ports.vehicles.applyStatus('v', 'out_of_service', 'Siniestro X')).toEqual({
      ok: true,
      value: null,
    });
    expect(seen.map((entry) => entry.id)).toEqual([
      'incidents.list',
      'incidents.list',
      'incidents.get',
      'incidents.create',
      'incidents.update',
      'incidents.suggestions',
      'incidents.timeline',
      'incidents.nextSteps',
      'incidents.transition',
      'incidents.insurance.update',
      'incidents.resolution.update',
      'incidents.thirdParties.list',
      'incidents.thirdParties.create',
      'incidents.thirdParties.update',
      'incidents.thirdParties.remove',
      'incidents.evidence.list',
      'incidents.evidence.upload',
      'incidents.evidence.detach',
      'incidents.evidence.content',
      'vehicles.get',
      'vehicles.status',
    ]);
    expect(seen[3]?.input).toMatchObject({ idempotencyKey: 'key-1' });
    expect(seen[8]?.input).toMatchObject({ idempotencyKey: 'key-2', params: { incidentId: 'i' } });
    expect(seen[14]?.input).toEqual({
      params: { incidentId: 'i', partyId: 'p' },
      body: { version: 3 },
    });
    expect(seen[20]?.input).toEqual({
      params: { id: 'v' },
      body: { version: 7, status: 'out_of_service', reason: 'Siniestro X' },
    });
  });

  it('stops when the vehicle cannot be read or the status change is refused', async () => {
    const refusal = { ok: false, error: { status: 403, code: 'forbidden' } };
    const reading = createIncidentPorts({ call: async () => refusal } as unknown as BffClient);
    expect(await reading.vehicles.applyStatus('v', 'active', 'r')).toBe(refusal);
    const writing = createIncidentPorts({
      call: async (id: string) =>
        id === 'vehicles.get' ? { ok: true, value: { version: 1 } } : refusal,
    } as unknown as BffClient);
    expect(await writing.vehicles.applyStatus('v', 'active', 'r')).toBe(refusal);
  });
});

describe('canvasCompress', () => {
  const original = { bitmap: globalThis.createImageBitmap };
  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.createImageBitmap = original.bitmap;
  });
  let closeBitmap = vi.fn();
  const stubCanvas = (sizes: (quality: number, width: number) => number, hasContext = true) => {
    const draw = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() =>
      hasContext ? { drawImage: draw } : null) as never);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
      this: HTMLCanvasElement,
      callback: BlobCallback,
      _type?: string,
      quality?: number,
    ) {
      callback(new Blob([new Uint8Array(sizes(quality ?? 1, this.width))]));
    } as never);
    closeBitmap = vi.fn();
    globalThis.createImageBitmap = vi.fn(async () => ({
      width: 4000,
      height: 3000,
      close: closeBitmap,
    })) as never;
    return draw;
  };

  it('re-encodes a large photo, lowering quality and size until it fits', async () => {
    const draw = stubCanvas((quality, width) =>
      width > 2000 ? 5_000_000 : quality > 0.8 ? 3_000_000 : 1_000_000,
    );
    const blob = await canvasCompress(new Blob(['x']), 2_000_000);
    expect(blob.size).toBe(1_000_000);
    expect(draw).toHaveBeenCalled();
    expect(closeBitmap).toHaveBeenCalledTimes(1);
  });

  it('gives up when the browser cannot reach the target or has no canvas', async () => {
    stubCanvas(() => 9_000_000);
    await expect(canvasCompress(new Blob(['x']), 2_000_000)).rejects.toThrow('target size');
    expect(closeBitmap).toHaveBeenCalledTimes(1);
    stubCanvas(() => 1, false);
    await expect(canvasCompress(new Blob(['x']), 2_000_000)).rejects.toThrow('no canvas');
  });
});
