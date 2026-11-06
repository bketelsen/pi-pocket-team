// The budget guard: `<data>/spend.json` holds the budget, the settled spend, open reservations and settled entries.
// Every read-modify-write holds the lock `spend.json.lock` (a mkdir lock, stale after 60 s) and writes the file
// atomically. A try reserves its cap before it starts and settles its real list cost after it ends.
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { pidAlive, privateDir, readJson, withDirLock, writeJsonAtomic } from "./common.mjs";

/** An empty spend file. */
const empty = () => ({ budget: null, settled: 0, reservations: [], entries: [] });

/** Round a dollar amount to 1/1,000,000, so sums do not drift. */
const usd = (value) => Math.round(value * 1e6) / 1e6;

/** The spend file of a data dir. */
export const spendPath = (data) => join(data, "spend.json");

/** Read the spend file (no lock): the budget state, or an empty state when there is none. */
export async function readSpend(data) {
    return { ...empty(), ...(await readJson(spendPath(data), empty())) };
}

/** The sum of the open reservations' caps. */
export const reserved = (spend) => usd(spend.reservations.reduce((sum, r) => sum + r.cap, 0));

/** A one-line view of the budget state. */
export function describeSpend(spend) {
    if (spend.budget == null) {
        return "no budget set";
    }

    const held = reserved(spend);
    const free = usd(spend.budget - spend.settled - held);

    return `budget $${spend.budget}, settled $${spend.settled}, reserved $${held} (${spend.reservations.length} open), free $${free}`;
}

/** Run `change(spend)` under the lock, and write the spend file when it returns. */
async function update(data, change, options = {}) {
    await privateDir(data);

    return withDirLock(
        `${spendPath(data)}.lock`,
        async () => {
            const spend = await readSpend(data);
            const result = await change(spend);

            await writeJsonAtomic(spendPath(data), spend);

            return result;
        },
        options,
    );
}

/** Set the budget, in US dollars. */
export function setBudget(data, budget, options) {
    if (!Number.isFinite(budget) || budget < 0) {
        throw new Error(`bad budget: ${budget}`);
    }

    return update(
        data,
        (spend) => {
            spend.budget = budget;

            return spend;
        },
        options,
    );
}

/**
 * Reserve `cap` dollars for 1 try. Refused when no budget is set, or when settled + reserved + cap > budget.
 * Returns `{ ok: true, id }` or `{ ok: false, reason }`.
 */
export function reserve(data, { task, model, stage, try: tryNo, cap, pid = process.pid }, options) {
    return update(
        data,
        (spend) => {
            if (spend.budget == null) {
                return {
                    ok: false,
                    reason: "no budget set (run: node bench/budget.mjs set --budget <usd>)",
                };
            }

            const total = usd(spend.settled + reserved(spend) + cap);

            if (total > spend.budget) {
                return {
                    ok: false,
                    reason: `budget refused: settled $${spend.settled} + reserved $${reserved(spend)} + cap $${cap} > budget $${spend.budget}`,
                };
            }

            const id = randomUUID();

            spend.reservations.push({
                id,
                task,
                model,
                stage,
                try: tryNo,
                cap,
                pid,
                at: new Date().toISOString(),
            });

            return { ok: true, id };
        },
        options,
    );
}

/** Settle a reservation: remove it and add an entry with its real cost and tokens. */
export function settle(data, id, { cost, tokens }, options) {
    return update(
        data,
        (spend) => {
            const index = spend.reservations.findIndex((r) => r.id === id);

            if (index < 0) {
                return false;
            }

            const [r] = spend.reservations.splice(index, 1);
            const real = r.cap === 0 ? 0 : usd(cost);

            spend.settled = usd(spend.settled + real);
            spend.entries.push({
                id,
                task: r.task,
                model: r.model,
                stage: r.stage,
                try: r.try,
                cost: real,
                tokens,
                at: new Date().toISOString(),
            });

            return true;
        },
        options,
    );
}

/**
 * Settle each reservation whose pid is dead at its full cap (the try's real cost is unknown).
 * Returns the reaped reservations.
 */
export function reap(data, { alive = pidAlive } = {}, options) {
    return update(
        data,
        (spend) => {
            const dead = spend.reservations.filter((r) => !alive(r.pid));

            for (const r of dead) {
                spend.settled = usd(spend.settled + r.cap);
                spend.entries.push({
                    id: r.id,
                    task: r.task,
                    model: r.model,
                    stage: r.stage,
                    try: r.try,
                    cost: r.cap,
                    tokens: null,
                    reaped: true,
                    at: new Date().toISOString(),
                });
            }

            spend.reservations = spend.reservations.filter((r) => alive(r.pid));

            return dead;
        },
        options,
    );
}
