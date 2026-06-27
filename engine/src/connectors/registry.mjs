/**
 * Connector registry. Resolves the connector for a resource type.
 * Register new resource types here (single place to extend the engine).
 * @module connectors/registry
 */

import { S3Connector } from './s3-connector.mjs';
import { IamConnector } from './iam-connector.mjs';

const CONNECTORS = [S3Connector, IamConnector];

const byType = new Map();
for (const C of CONNECTORS) {
  for (const t of C.resourceTypes) byType.set(t, new C());
}

/** @returns {import('./base-connector.mjs').BaseConnector | null} */
export const getConnector = (resourceType) => byType.get(resourceType) || null;

/** @returns {boolean} true if automated enforcement is supported for this resource type. */
export const isSupported = (resourceType) => byType.has(resourceType);

/** @returns {string[]} all supported resource types. */
export const supportedTypes = () => [...byType.keys()];
