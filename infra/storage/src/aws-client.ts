import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { S3ObjectClient } from './index.js';

export interface AwsS3Config {
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Only for an S3-compatible stub in tests; real AWS leaves it unset. */
  readonly endpoint?: string;
}

const statusOf = (error: unknown): number | undefined =>
  (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode;

/** Server-side S3 client over the AWS SDK: no presigned URLs, no listing, ambient credentials never read. */
export class AwsS3ObjectClient implements S3ObjectClient {
  private readonly s3: S3Client;
  public constructor(config: AwsS3Config, s3?: S3Client) {
    this.s3 =
      s3 ??
      new S3Client({
        region: config.region,
        credentials: {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
        },
        ...(config.endpoint ? { endpoint: config.endpoint, forcePathStyle: true } : {}),
      });
  }
  public async putObject(input: Parameters<S3ObjectClient['putObject']>[0]) {
    try {
      await this.s3.send(
        new PutObjectCommand({
          Bucket: input.bucket,
          Key: input.key,
          Body: input.body,
          ContentType: input.contentType,
          IfNoneMatch: input.ifNoneMatch,
          ...(input.kmsKeyId
            ? { ServerSideEncryption: 'aws:kms' as const, SSEKMSKeyId: input.kmsKeyId }
            : {}),
        }),
      );
      return 'created' as const;
    } catch (error) {
      if (statusOf(error) === 412) return 'exists' as const;
      throw error;
    }
  }
  public async getObject(input: { bucket: string; key: string }): Promise<Uint8Array | null> {
    try {
      const out = await this.s3.send(
        new GetObjectCommand({ Bucket: input.bucket, Key: input.key }),
      );
      return out.Body ? await out.Body.transformToByteArray() : null;
    } catch (error) {
      if (statusOf(error) === 404) return null;
      throw error;
    }
  }
  public async deleteObject(input: { bucket: string; key: string }): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: input.bucket, Key: input.key }));
  }
}
