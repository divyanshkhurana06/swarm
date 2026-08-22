import { createPublicClient, http, type Hex } from "viem";
import { chain, TASK_POOL, taskPoolAbi } from "./contracts";

/**
 * Reading tasks.
 *
 * Specs live on-chain, so a requester posts a job and a worker anywhere can
 * see it with nothing in between -- no database, no API, nothing that has to
 * still be running tomorrow. Reading is just a contract call.
 */

export const publicClient = createPublicClient({ chain, transport: http() });

export type Item = { id: number; text: string };

export enum Mode {
  FirstCome = 0,
  Majority = 1,
  Survey = 2,
}

export type TaskSpec = {
  title: string;
  question: string;
  /** "image" | "text" | "survey" -- presentation only; Mode is the contract's. */
  kind?: string;
  answers: Record<string, string>;
  items: Item[];
};

export type Task = {
  id: number;
  spec: TaskSpec;
  requester: Hex;
  rewardPerLabel: bigint;
  funded: bigint;
  paidOut: bigint;
  answers: number;
  open: boolean;
  itemCount: number;
  mode: Mode;
  quorum: number;
};

const read = <T,>(functionName: string, args: readonly unknown[] = []) =>
  publicClient.readContract({
    address: TASK_POOL,
    abi: taskPoolAbi,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    functionName: functionName as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    args: args as any,
  }) as Promise<T>;

export async function loadTask(id: number): Promise<Task | null> {
  try {
    const [raw, spec, items] = await Promise.all([
      read<{
        requester: Hex;
        rewardPerLabel: bigint;
        funded: bigint;
        paidOut: bigint;
        labelCount: bigint;
        open: boolean;
        mode: number;
        quorum: number;
      }>("tasks", [BigInt(id)]),
      read<string>("taskSpec", [BigInt(id)]),
      read<number>("itemCount", [BigInt(id)]),
    ]);

    // A task posted before specs moved on-chain has nothing to show a worker.
    if (!spec) return null;

    return {
      id,
      spec: JSON.parse(spec) as TaskSpec,
      requester: raw.requester,
      rewardPerLabel: raw.rewardPerLabel,
      funded: raw.funded,
      paidOut: raw.paidOut,
      answers: Number(raw.labelCount),
      open: raw.open,
      itemCount: Number(items),
      mode: Number(raw.mode) as Mode,
      quorum: Number(raw.quorum),
    };
  } catch {
    return null;
  }
}

export async function loadTasks(): Promise<Task[]> {
  const count = Number(await read<bigint>("taskCount"));
  const tasks = await Promise.all(
    Array.from({ length: count }, (_, i) => loadTask(i))
  );
  return tasks.filter((t): t is Task => t !== null).reverse();
}

/** Questions a survey worker still has to answer. */
export async function surveyProgress(task: Task, workerId: Hex) {
  const [answered, paid] = await Promise.all([
    read<number>("answeredCount", [BigInt(task.id), workerId]),
    read<boolean>("surveyPaid", [BigInt(task.id), workerId]),
  ]);
  return { answered: Number(answered), paid };
}

/** Items this worker has not answered yet. */
export async function unansweredItems(
  task: Task,
  workerId: Hex
): Promise<Item[]> {
  const checks = await Promise.all(
    task.spec.items.map((item) =>
      read<boolean>("hasLabeled", [BigInt(task.id), workerId, BigInt(item.id)])
        .then((done) => (done ? null : item))
        .catch(() => item)
    )
  );
  return checks.filter((i): i is Item => i !== null);
}

/** Completed survey responses, question by question, per respondent. */
export async function loadSurveyResponses(task: Task) {
  const ids = await read<readonly Hex[]>("respondents", [BigInt(task.id)]);
  return Promise.all(
    ids.map(async (workerId) => ({
      workerId,
      answers: await read<readonly string[]>("surveyResponse", [
        BigInt(task.id),
        workerId,
      ]),
    }))
  );
}

/** The labelled dataset: per-item vote counts, straight from the contract. */
export async function loadResults(task: Task) {
  const [zeros, ones] = await read<[readonly number[], readonly number[]]>(
    "results",
    [BigInt(task.id)]
  );

  return task.spec.items.map((item, i) => {
    const no = Number(zeros[i] ?? 0);
    const yes = Number(ones[i] ?? 0);
    const total = no + yes;
    return {
      id: item.id,
      text: item.text,
      no,
      yes,
      total,
      // The majority answer, and how much of the crowd agreed on it. Agreement
      // is the honest quality signal here: a 50/50 split means the item is
      // ambiguous, not that the workers were careless.
      label: total === 0 ? null : yes >= no ? 1 : 0,
      agreement: total === 0 ? 0 : Math.max(no, yes) / total,
    };
  });
}

/** address -> the left-padded worker id the ledger uses. */
export const workerIdOfAddress = (address: string): Hex =>
  `0x${"0".repeat(24)}${address.slice(2)}`.toLowerCase() as Hex;
