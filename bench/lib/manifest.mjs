// The manifest, the candidate models, DeepSeek's peak hours and the halogen lease.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { BENCH_DIR, readJson } from "./common.mjs";

/** The fields of a manifest task, schema v1. */
export const TASK_FIELDS = [
    "id",
    "repo",
    "thread",
    "pr",
    "parent",
    "merge",
    "brief",
    "briefSource",
    "setup",
    "check",
    "hiddenTests",
    "hiddenCommand",
    "size",
    "features",
    "owner",
];

/** The lease's thread for the bench. */
export const LEASE_THREAD = "T1064";

/** The halogen lease resource. */
export const LEASE_RESOURCE = "halogen";

/** A usage error: the runner exits 1. */
export class UsageError extends Error {}

/** Read a manifest file, and check each task has the fields of schema v1. */
export async function loadManifest(file) {
    let manifest;

    try {
        manifest = JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
        throw new UsageError(`cannot read manifest ${file}: ${error.message}`);
    }

    if (!Array.isArray(manifest?.tasks)) {
        throw new UsageError(`manifest ${file} has no tasks list`);
    }

    for (const task of manifest.tasks) {
        const missing = TASK_FIELDS.filter((field) => !(field in task));

        if (missing.length) {
            throw new UsageError(`manifest task ${task.id ?? "?"} lacks ${missing.join(", ")}`);
        }

        if (!/^[0-9a-f]{40}$/.test(task.parent) || !/^[0-9a-f]{40}$/.test(task.merge)) {
            throw new UsageError(
                `manifest task ${task.id}: parent and merge must be full commit ids`,
            );
        }

        if (!/^[A-Za-z0-9._-]+$/.test(task.id)) {
            throw new UsageError(`manifest task id ${task.id} is not a safe name`);
        }
    }

    return manifest;
}

/** The candidate models of `bench/models.json`. */
export async function loadModels(file = join(BENCH_DIR, "models.json")) {
    return (await readJson(file, { models: [] })).models;
}

/** True when `date` falls in the model's peak hours (`peakUtc`: [[start, end)] UTC hours). */
export function inPeak(model, date) {
    const hour = date.getUTCHours();

    return (model.peakUtc ?? []).some(([start, end]) => hour >= start && hour < end);
}

/** The first moment at or after `date` outside the model's peak hours. */
export function peakEnds(model, date) {
    const next = new Date(date);

    while (inPeak(model, next)) {
        next.setUTCHours(next.getUTCHours() + 1, 0, 0, 0);
    }

    return next;
}

/** The lease folder: env `LEASE_DIR`, else `~/.local/state/leases`. */
export const leaseDir = (env = process.env) =>
    env.LEASE_DIR || join(homedir(), ".local", "state", "leases");

/** The fields of a lease's `info` file (key=value lines), or null when there is no lease. */
export async function readLease(resource, env = process.env) {
    let text;

    try {
        text = await readFile(join(leaseDir(env), resource, "info"), "utf8");
    } catch {
        return null;
    }

    const fields = {};

    for (const line of text.split("\n")) {
        const at = line.indexOf("=");

        if (at > 0) {
            fields[line.slice(0, at)] = line.slice(at + 1);
        }
    }

    return fields;
}

/** True when the halogen lease is held for the bench's thread. */
export async function holdsHalogenLease(env = process.env) {
    return (await readLease(LEASE_RESOURCE, env))?.thread === LEASE_THREAD;
}
