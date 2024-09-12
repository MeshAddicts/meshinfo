import { Feature, Map as OlMap, View } from "ol";
import { Point } from "ol/geom";
import TileLayer from "ol/layer/Tile";
import VectorLayer from "ol/layer/Vector";
import { fromLonLat } from "ol/proj";
import { OSM } from "ol/source";
import VectorSource from "ol/source/Vector";
import { Circle, Fill, Stroke, Style } from "ol/style";
import { useEffect, useRef, useState } from "react";

import { INode } from "../types";

export const NodeMap = ({ node }: { node: INode }) => {
  const mapRef = useRef<HTMLDivElement>(null);
  const [olMap, setMap] = useState<OlMap>();

  const defaultStyle = new Style({
    image: new Circle({
      radius: 6,
      fill: new Fill({
        color: "rgba(0, 0, 240, 1)",
      }),
      stroke: new Stroke({
        color: "white",
        width: 2,
      }),
    }),
  });

  const offlineStyle = new Style({
    image: new Circle({
      radius: 6,
      fill: new Fill({
        color: "rgba(0, 0, 0, 0.50)",
      }),
      stroke: new Stroke({
        color: "white",
        width: 2,
      }),
    }),
  });

  const onlineStyle = new Style({
    image: new Circle({
      radius: 6,
      fill: new Fill({
        color: "rgba(50, 240, 50, 1)",
      }),
      stroke: new Stroke({
        color: "white",
        width: 2,
      }),
    }),
  });

  useEffect(() => {
    if (olMap) return;
    if (!node.position || !mapRef) return;

    const tileLayer = new TileLayer({
      source: new OSM(),
    });

    if (
      window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: dark)").matches
    ) {
      tileLayer.on("prerender", (evt) => {
        if (evt.context) {
          const context = evt.context as CanvasRenderingContext2D;
          context.filter = "grayscale(80%) invert(100%) ";
          context.globalCompositeOperation = "source-over";
        }
      });
      tileLayer.on("postrender", (evt) => {
        if (evt.context) {
          const context = evt.context as CanvasRenderingContext2D;
          context.filter = "none";
        }
      });
    }

    const map = new OlMap({
      layers: [tileLayer],
      target: mapRef.current as HTMLElement,
      view: new View({
        center: fromLonLat([node.position.longitude, node.position.latitude]),
        zoom: 12,
      }),
    });
    setMap(map);

    const features = [];
    const feature = new Feature({
      geometry: new Point(
        fromLonLat([node.position.longitude, node.position.latitude])
      ),
      node,
    });

    if (node.active) {
      feature.setStyle(onlineStyle);
    } else {
      feature.setStyle(offlineStyle);
    }
    features.push(feature);

    const layer = new VectorLayer({
      style: defaultStyle,
      source: new VectorSource({
        features,
      }),
    });
    map.addLayer(layer);

    // eslint-disable-next-line consistent-return
    return () => {
      map.setTarget(undefined);
    };

    // only needs to run once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      id="map"
      className="map"
      ref={mapRef}
      style={{ height: "300px", width: "100%" }}
    />
  );
};
