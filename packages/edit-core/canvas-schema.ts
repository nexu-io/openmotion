import type { PlayheadSamples } from "./playhead-edit.ts";
import type { CanvasBox } from "./canvas-box.ts";
import type {
  ElementRebase,
  PatchOperation,
  SourceMutationTarget,
  UnwrapChildTrack,
} from "@hyperframes/studio-server/source-mutation";

export interface CanvasElementPatch {
  target: SourceMutationTarget;
  operations: PatchOperation[];
  fontFaceCss?: string;
}
export type CanvasCommand =
  | { kind: "setCanvasBox"; target: SourceMutationTarget; box: CanvasBox }
  | ({
      kind: "moveCanvasElement";
      target: SourceMutationTarget;
      time?: number;
      staticBox?: CanvasBox;
      samples?: PlayheadSamples;
    } & (
      | { mode?: "playhead"; x: number; y: number; delta?: never }
      | { mode?: "wholePath"; delta: { x: number; y: number }; x?: never; y?: never }
    ))
  | { kind: "editElements"; patches: CanvasElementPatch[] }
  | {
      kind: "setAnimatedValues";
      animationId: string;
      samples?: PlayheadSamples;
      at: { time: number } | { percentage: number };
      values: Record<string, number>;
    }
  | { kind: "editAnimation"; mutations: Record<string, unknown>[] }
  | { kind: "deleteCanvasElements"; targets: SourceMutationTarget[] }
  | {
      kind: "duplicateElement";
      target: SourceMutationTarget;
      newId: string;
      delta?: number;
    }
  | {
      kind: "groupElements";
      targets: SourceMutationTarget[];
      groupId: string;
      bbox: { left: number; top: number; width: number; height: number };
      rebases: ElementRebase[];
    }
  | {
      kind: "ungroupElements";
      target: SourceMutationTarget;
      childTracks?: UnwrapChildTrack[];
    };

const id = { type: "string", minLength: 1, maxLength: 1024 };
const number = { type: "number" };
const index = { type: "integer", minimum: 0 };
const obj = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});
const array = (items: unknown, minItems = 1) => ({
  type: "array",
  items,
  minItems,
  maxItems: 200,
});
const target = {
  ...obj(
    {
      id: { type: ["string", "null"] },
      hfId: id,
      selector: id,
      selectorIndex: index,
    },
    [],
  ),
  anyOf: ["id", "hfId", "selector"].map((key) => ({
    required: [key],
    properties: { [key]: id },
  })),
};
const op = obj(
  {
    type: {
      enum: ["inline-style", "attribute", "html-attribute", "text-content", "rich-text"],
    },
    property: { type: "string" },
    value: { type: ["string", "null"] },
    childSelector: id,
    childIndex: index,
  },
  ["type", "property", "value"],
);
const schema = (
  kind: CanvasCommand["kind"],
  fields: Record<string, unknown>,
  required = Object.keys(fields),
) =>
  obj(
    {
      kind: { enum: [kind] },
      compositionPath: { type: "string", minLength: 1, maxLength: 240 },
      ...fields,
    },
    ["kind", "compositionPath", ...required],
  );
const box = obj(
  {
    left: number,
    top: number,
    makeRelative: { type: "boolean" },
    corner: { enum: ["nw", "ne", "sw", "se"] },
    extraAxes: { enum: ["x", "y", "xy"] },
    width: number,
    height: number,
  },
  ["left", "top", "makeRelative"],
);
const channelValues = { type: "object", additionalProperties: number };
const samples = obj(
  {
    start: channelValues,
    end: channelValues,
    ease: id,
    backfill: channelValues,
    holdFromStart: { type: "boolean" },
  },
  [],
);
export const canvasCommandSchemas = [
  schema("setCanvasBox", { target, box }),
  {
    ...schema(
      "moveCanvasElement",
      {
        target,
        mode: { enum: ["playhead", "wholePath"] },
        delta: obj({ x: number, y: number }),
        x: number,
        y: number,
        time: { type: "number", minimum: 0 },
        staticBox: box,
        samples,
      },
      ["target"],
    ),
    anyOf: [
      { required: ["delta"], properties: { mode: { enum: ["wholePath"] } } },
      { required: ["x", "y"], properties: { mode: { enum: ["playhead"] } } },
    ],
    description:
      "Drag an element. Use delta for the default Studio gesture (translate the whole path). Supply staticBox (measured CSS left, top, and makeRelative) if multiple transforms share a responsive layout. Use x and y at a composition time for an absolute playhead edit; mode may explicitly be wholePath or playhead.",
  },
  schema("editElements", {
    patches: array(
      obj(
        {
          target,
          operations: array(op),
          fontFaceCss: { type: "string", maxLength: 8192 },
        },
        ["target", "operations"],
      ),
    ),
  }),
  schema(
    "setAnimatedValues",
    {
      animationId: id,
      samples,
      at: {
        oneOf: [
          obj({ time: { type: "number", minimum: 0 } }),
          obj({ percentage: { type: "number", minimum: 0, maximum: 100 } }),
        ],
      },
      values: { type: "object", minProperties: 1, additionalProperties: number },
    },
    ["animationId", "at", "values"],
  ),
  schema("editAnimation", {
    mutations: array({
      type: "object",
      required: ["type"],
      properties: { type: id },
      additionalProperties: true,
    }),
  }),
  schema("deleteCanvasElements", { targets: array(target) }),
  schema("duplicateElement", { target, newId: id, delta: number }, ["target", "newId"]),
  schema("groupElements", {
    targets: array(target),
    groupId: id,
    bbox: obj({
      left: number,
      top: number,
      width: { type: "number", minimum: 0 },
      height: { type: "number", minimum: 0 },
    }),
    rebases: array(obj({ target, left: number, top: number, track: index }, ["target", "left", "top"]), 0),
  }),
  schema(
    "ungroupElements",
    {
      target,
      childTracks: array(obj({ target, track: index }, ["target"]), 0),
    },
    ["target"],
  ),
];
const kinds = canvasCommandSchemas.map((s) => (s.properties.kind as { enum: string[] }).enum[0]);
export const isCanvasCommand = (command: { kind: string }): command is CanvasCommand =>
  kinds.includes(command.kind);
