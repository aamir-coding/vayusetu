export const H3_RESOLUTIONS = {
  OPERATIONAL: 8,
  FEDERATED: 6,
} as const;

export type H3Resolution = (typeof H3_RESOLUTIONS)[keyof typeof H3_RESOLUTIONS];