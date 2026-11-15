// The classifier registry. To add a classifier: write it as a module in this
// directory, import it here and add it to the array. Nothing else changes.
import type { Classifier } from "../types.js";
import { pathCategory } from "./path-category.js";

export const classifiers: readonly Classifier<any>[] = [pathCategory]; // eslint-disable-line @typescript-eslint/no-explicit-any
