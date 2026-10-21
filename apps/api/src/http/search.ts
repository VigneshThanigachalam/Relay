// User search is literal text, never a regular-expression program. Keep the
// transport length bounded in each contract; queries retain their time limit.
export const literalContains = (value: string) =>
  new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
