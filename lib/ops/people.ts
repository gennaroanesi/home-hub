import { listAllPages } from "../list-all";
import type { OpContext } from "./context";
import { OpError } from "./define";

export interface OpPerson {
  id: string;
  name: string;
}

/** personId wins, then personName, then the actor (Janet's sender, Muse's MUSE_SENDER). */
export async function resolvePerson(
  ctx: OpContext,
  input: { personId?: string | null; personName?: string | null },
): Promise<OpPerson> {
  const people = await listAllPages<OpPerson>(ctx.client.models.homePerson);
  if (input.personId) {
    const p = people.find((x) => x.id === input.personId);
    if (!p) throw new OpError(`No person with id ${input.personId}`);
    return p;
  }
  const name = (input.personName ?? ctx.actor.personName ?? "").trim().toLowerCase();
  if (!name) throw new OpError("Say whose: personId or personName");
  const p = people.find((x) => x.name.toLowerCase() === name);
  if (!p) throw new OpError(`No person named "${input.personName ?? ctx.actor.personName}"`);
  return p;
}
