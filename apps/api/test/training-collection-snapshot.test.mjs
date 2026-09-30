import test from "node:test";
import assert from "node:assert/strict";
import { assertTrainingCollectionSnapshot } from "../src/routes/internal-ai-jobs.ts";

const first = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";

test("training synthesis rejects a collection attached after the input snapshot", () => {
  const captured = [{ id: first, schemaVersion: 1 }];
  const current = [{ id: first, schema_version: 1 }, { id: second, schema_version: 1 }];
  assert.throws(() => assertTrainingCollectionSnapshot(captured, current), (error) =>
    error.code === "TRAINING_INPUT_STALE" && error.statusCode === 409);
});

test("training synthesis rejects removed collections and changed schemas", () => {
  const captured = [{ id: first, schemaVersion: 1 }, { id: second, schemaVersion: 2 }];
  assert.throws(() => assertTrainingCollectionSnapshot(captured, [{ id: first, schema_version: 1 }]), (error) =>
    error.code === "TRAINING_INPUT_STALE" && error.statusCode === 409);
  assert.throws(() => assertTrainingCollectionSnapshot(captured, [
    { id: first, schema_version: 1 }, { id: second, schema_version: 3 },
  ]), (error) => error.code === "TRAINING_INPUT_STALE" && error.details?.collectionId === second);
});

test("training synthesis accepts the same snapshot set regardless of query order", () => {
  assert.doesNotThrow(() => assertTrainingCollectionSnapshot([
    { id: first, schemaVersion: 1 }, { id: second, schemaVersion: 2 },
  ], [
    { id: second, schema_version: 2 }, { id: first, schema_version: 1 },
  ]));
  assert.doesNotThrow(() => assertTrainingCollectionSnapshot([], []));
  assert.doesNotThrow(() => assertTrainingCollectionSnapshot(undefined, [{ id: first, schema_version: 1 }]));
});
