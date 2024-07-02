import "ol/ol.css";

import { Feature, Map as OlMap, View } from "ol";
import { click } from "ol/events/condition";
import Point from "ol/geom/Point";
import Select from "ol/interaction/Select";
import TileLayer from "ol/layer/Tile";
import VectorLayer from "ol/layer/Vector";
import Overlay from "ol/Overlay";
import { fromLonLat } from "ol/proj";
import OSM from "ol/source/OSM";
import VectorSource from "ol/source/Vector";
import { Circle, Fill, Stroke, Style } from "ol/style";
import { useEffect, useMemo, useRef } from "react";

import { useGetNodesQuery } from "../slices/apiSlice";

export function Map() {
  const mapRef = useRef<HTMLDivElement>(null);
  const { data: nodes = {} } = useGetNodesQuery();

  const serverNode = useMemo(() => nodes["!4355f528"], [nodes]);

  const reverseGeocode = async (lon: string, lat: string) => {
    const response = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&lon=${lon}&lat=${lat}`,
    );
    const json = await response.json();
    return json;
  };

  useEffect(() => {
    if (!serverNode || !nodes || !mapRef) {
      return;
    }

    const defaultPosition = { latitude: 38.5816, longitude: -121.4944 };
    const serverPosition = serverNode?.position
      ? {
          latitude: serverNode.position.latitude_i / 10000000,
          longitude: serverNode.position.longitude_i / 10000000,
        }
      : defaultPosition;

    const initialMap = new OlMap({
      layers: [
        new TileLayer({
          source: new OSM(),
        }),
      ],
      target: mapRef.current as HTMLElement,
      view: new View({
        center: fromLonLat([serverPosition.longitude, serverPosition.latitude]),
        zoom: 8.3,
      }),
    });

    const features = Object.entries(nodes)
      .map(([id, node]) => {
        if (node.position) {
          return new Feature({
            geometry: new Point(
              fromLonLat([
                node.position.longitude_i / 10000000,
                node.position.latitude_i / 10000000,
              ]),
            ),
            node: {
              id,
              shortname: node.shortname,
              longname: node.longname,
              last_seen: node.last_seen,
              position: [
                node.position.longitude_i / 10000000,
                node.position.latitude_i / 10000000,
              ],
            },
          });
        }
        return null;
      })
      .filter(Boolean) as Feature<Point>[];

    const vectorLayer = new VectorLayer({
      style: new Style({
        image: new Circle({
          radius: 10,
          fill: new Fill({ color: "rgba(0, 0, 255, 0.1)" }),
          stroke: new Stroke({ color: "blue", width: 1 }),
        }),
      }),
      source: new VectorSource({ features }),
    });

    initialMap.addLayer(vectorLayer);

    const overlayContainer = document.getElementById("popup");
    const overlayContent = document.getElementById("popup-content");
    const overlayCloser = document.getElementById("popup-closer");

    if (!overlayContainer || !overlayContent || !overlayCloser) {
      return;
    }

    const initialOverlay = new Overlay({
      element: overlayContainer,
      autoPan: true,
    });
    initialMap.addOverlay(initialOverlay);

    const select = new Select({
      condition: click,
      style: new Style({
        image: new Circle({
          radius: 10,
          fill: new Fill({ color: "rgba(255, 0, 0, 0.1)" }),
          stroke: new Stroke({ color: "red", width: 1 }),
        }),
      }),
    });
    initialMap.addInteraction(select);

    overlayCloser.onclick = () => {
      select.getFeatures().clear();
      initialOverlay.setPosition(undefined);
      overlayCloser.blur();
      return false;
    };

    initialMap.on("singleclick", async (event) => {
      if (initialMap.hasFeatureAtPixel(event.pixel)) {
        const { coordinate } = event;
        const feature = initialMap.forEachFeatureAtPixel(
          event.pixel,
          (feat) => feat,
        );
        if (feature) {
          const properties = feature.getProperties();
          const { node } = properties;
          const address = await reverseGeocode(
            node.position[0],
            node.position[1],
          );
          const displayName = [
            address.address.town,
            address.address.city,
            address.address.county,
            address.address.state,
            address.address.country,
          ]
            .filter(Boolean)
            .join(", ");

          overlayContent.innerHTML = `<b>${node.longname}</b><br/>
            ${node.shortname} / ${node.id}<br/><br/>
            <b>Position</b><br/>${node.position}<br/><br/>
            <b>Location</b><br/>${displayName}<br/><br/>
            <b>Last Seen</b><br/>${node.last_seen}<br/><br/>`;

          initialOverlay.setPosition(fromLonLat(node.position));
        } else {
          overlayContent.innerHTML = "<b>Unknown</b>";
          initialOverlay.setPosition(coordinate);
        }
      } else {
        initialOverlay.setPosition(undefined);
        overlayCloser.blur();
      }
    });
  }, [nodes, serverNode]);

  return (
    <>
      <h1>Map</h1>
      <p>
        Map of the mesh as seen by <b>KE-R</b> (!4355f528).
      </p>
      <p>
        Last updated:
        {new Date().toLocaleString()}
      </p>

      <div id="map" className="map h-96" ref={mapRef} />
      <div id="popup" className="ol-popup">
        {/* eslint-disable-next-line jsx-a11y/anchor-is-valid, jsx-a11y/anchor-has-content, jsx-a11y/control-has-associated-label */}
        <a href="#" id="popup-closer" className="ol-popup-closer" />
        <div id="popup-content" />
      </div>

      <style>
        {`
        .ol-popup {
          position: absolute;
          background-color: white;
          box-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);
          padding: 15px;
          border-radius: 10px;
          border: 1px solid #cccccc;
          bottom: 12px;
          left: -50px;
          min-width: 280px;
        }
        .ol-popup:after,
        .ol-popup:before {
          top: 100%;
          border: solid transparent;
          content: " ";
          height: 0;
          width: 0;
          position: absolute;
          pointer-events: none;
        }
        .ol-popup:after {
          border-top-color: white;
          border-width: 10px;
          left: 48px;
          margin-left: -10px;
        }
        .ol-popup:before {
          border-top-color: #cccccc;
          border-width: 11px;
          left: 48px;
          margin-left: -11px;
        }
        .ol-popup-closer {
          text-decoration: none;
          position: absolute;
          top: 2px;
          right: 8px;
        }
        .ol-popup-closer:after {
          content: "x";
        }
      `}
      </style>
    </>
  );
}
