import type { Witness, WitnessOf } from "../frames/claim.js";
import { readOrderWitness, SUBSTATION_CODECS } from "./ass.js";

export const subtitleWitnessOf: WitnessOf = (entry) => WITNESSES.get(entry.codecId) ?? null;

const WITNESSES: ReadonlyMap<string, Witness> = new Map<string, Witness>(
  [...SUBSTATION_CODECS].map((codec) => [codec, readOrderWitness] as const),
);
