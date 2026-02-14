import type { Coordinate } from "ol/coordinate";
import type { INode } from "../../types";

export type MapProvider = "osm" | "mapbox";

export type IMapNode = INode & {
  online: boolean;
  map_position?: Coordinate; // [lon, lat]
  neighbors?: {
    id: string;
    snr: number;
    distance: number;
  }[];
};

// OL Feature properties for click handling
export type IFeatureNode = {
  id: string;
  shortname?: string;
  longname?: string;
  last_seen?: string;
  position: Coordinate; // [lon, lat]
  online: boolean;
  neighbors?: {
    id: string;
    snr: number;
    distance: number;
  }[];
};

// Normalized shape for shared details rendering/link building
export type NodeLike = {
  id: string;
  shortname?: string;
  longname?: string;
  last_seen?: string;
  online: boolean;
  position: Coordinate; // [lon, lat]
  neighbors?: {
    id: string;
    snr: number;
    distance: number;
  }[];
};
