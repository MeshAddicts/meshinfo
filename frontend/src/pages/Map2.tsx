import { Feature, Map, Overlay, View } from "ol";
import { toStringHDMS } from "ol/coordinate";
import { Point } from "ol/geom";
import TileLayer from "ol/layer/Tile";
import VectorLayer from "ol/layer/Vector";
import { toLonLat } from "ol/proj";
import { OGCMapTile, OSM } from "ol/source";
import VectorSource from "ol/source/Vector";
import { useEffect } from "react";

export const Map2 = () => {
  useEffect(() => {
    const iconFeature = new Feature({
      geometry: new Point([0, 0]),
      name: "Null Island",
      population: 4000,
      rainfall: 500,
    });

    const vectorSource = new VectorSource({
      features: [iconFeature],
    });

    const vectorLayer = new VectorLayer({
      source: vectorSource,
    });

    const rasterLayer = new TileLayer({
      source: new OGCMapTile({
        url: "https://maps.gnosis.earth/ogcapi/collections/NaturalEarth:raster:HYP_HR_SR_OB_DR/map/tiles/WebMercatorQuad",
        crossOrigin: "",
      }),
    });

    const container = document.getElementById("popup");
    const overlay = new Overlay({
      element: container!,
      autoPan: {
        animation: {
          duration: 250,
        },
      },
    });

    const map = new Map({
      layers: [
        new TileLayer({
          source: new OSM(),
        }),
        vectorLayer,
      ],
      target: "markerpopupmap",
      view: new View({
        center: [0, 0],
        zoom: 3,
      }),
      overlays: [overlay],
    });

    /**
     * Add a click handler to the map to render the popup.
     */
    map.on("singleclick", (evt) => {
      const { coordinate } = evt;
      const hdms = toStringHDMS(toLonLat(coordinate));
      console.log(hdms);
      document.getElementById("popup-content")!.innerHTML =
        `<p>You clicked here:</p><code>${hdms}</code>`;

      overlay.setPosition(coordinate);
    });
    return () => map.setTarget();
  }, []);

  return (
    <>
      <div>
        <div id="markerpopupmap" style={{ width: "100%", height: "400px" }} />
      </div>
      <div id="popup" className="ol-popup" style={{ backgroundColor: "#fff" }}>
        <a href="#" id="popup-closer" className="ol-popup-closer" />
        <div id="popup-content" />
      </div>
    </>
  );
};
