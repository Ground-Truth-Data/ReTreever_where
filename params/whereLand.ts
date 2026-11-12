import { parseLandSegment } from "../lib/landPath";

/** A land's segment, `<slug>-<8-char id>`; never a view. */
export const match = (param: string): boolean => parseLandSegment(param) !== null;
