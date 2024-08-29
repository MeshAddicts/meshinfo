import { HeardBy } from "../components/HeardBy";
import { useGetNodesQuery, useGetTelemetryQuery } from "../slices/apiSlice";

export const Telemetry = () => {
  const { data: telemetry } = useGetTelemetryQuery();
  const { data: nodes } = useGetNodesQuery();

  if (!telemetry) {
    return <div>Loading...</div>;
  }

  if (!nodes) {
    return <div>Loading...</div>;
  }

  return (
    <div>
      <h5 className="mb-2 text-gray-500">Telemetry</h5>
      <h1 className="mb-2 text-xl">Telemetry</h1>
      <p className="mb-2">
        Telemetry as <HeardBy />
      </p>

      <table className="w-full max-w-full table-auto border-collapse border border-gray-500 bg-gray-50">
        <thead>
          <tr>
            <th className="p-1 border border-gray-500 bg-gray-400" align="left">
              Timestamp
            </th>
            <th className="p-1 border border-gray-500 bg-gray-400" align="left">
              Node
            </th>
            <th
              className="p-1 border border-gray-500 bg-gray-400"
              align="center"
            >
              <img
                src={`${import.meta.env.BASE_URL}images/icons/up.svg`}
                alt="Air Util TX"
                className="w-4 h-4 inline-block"
                title="Air Util TX"
              />
            </th>
            <th
              className="p-1 border border-gray-500 bg-gray-400"
              align="center"
            >
              <img
                src={`${import.meta.env.BASE_URL}images/icons/down.svg`}
                className="w-4 h-4 inline-block"
                alt="Channel Util"
                title="Channel Util"
              />
            </th>
            <th
              className="p-1 border border-gray-500 bg-gray-400"
              align="center"
            >
              <img
                src={`${import.meta.env.BASE_URL}images/icons/battery.svg`}
                className="w-6 h-6 inline-block"
                alt="Battery"
                title="Battery"
              />
            </th>
            <th
              className="p-1 border border-gray-500 bg-gray-400"
              align="center"
            >
              Uptime
            </th>
            <th
              className="p-1 border border-gray-500 bg-gray-400"
              align="center"
            >
              <img
                src={`${import.meta.env.BASE_URL}images/icons/voltage.svg`}
                className="w-4 h-4 inline-block"
                alt="Voltage"
                title="Voltage"
              />
            </th>
            <th
              className="p-1 hidden lg:table-cell border border-gray-500 bg-gray-400"
              align="center"
            >
              <img
                src={`${import.meta.env.BASE_URL}images/icons/current.svg`}
                className="w-5 h-5 inline-block"
                alt="Current"
                title="Current"
              />
            </th>
            <th
              className="p-1 hidden lg:table-cell border border-gray-500 bg-gray-400"
              align="center"
            >
              <img
                src={`${import.meta.env.BASE_URL}images/icons/pressure.svg`}
                className="w-4 h-4 inline-block"
                alt="Barometric Pressure"
                title="Barometric Pressure"
              />
            </th>
            <th
              className="p-1 hidden lg:table-cell border border-gray-500 bg-gray-400"
              align="center"
            >
              <img
                src={`${import.meta.env.BASE_URL}images/icons/relative-humidity.svg`}
                className="w-4 h-4 inline-block"
                alt="Relative Humidity"
                title="Relative Humidity"
              />
            </th>
            <th
              className="p-1 hidden lg:table-cell border border-gray-500 bg-gray-400"
              align="center"
            >
              <img
                src={`${import.meta.env.BASE_URL}images/icons/temperature.svg`}
                className="w-4 h-4 inline-block"
                alt="Temperature"
                title="Temperature"
              />
            </th>
            <th
              className="p-1 hidden lg:table-cell border border-gray-500 bg-gray-400"
              align="center"
            >
              <img
                src={`${import.meta.env.BASE_URL}images/icons/resistance.svg`}
                className="w-5 h-5 inline-block"
                alt="Gas Resistance"
                title="Gas Resistance"
              />
            </th>
          </tr>
        </thead>
        <tbody>
          {(telemetry ?? []).map((item, index) => {
            const inode = nodes[item.from];
            return (
              // eslint-disable-next-line react/no-array-index-key
              <tr key={`telemetry-${index}`}>
                <td className="p-1 border border-gray-400 text-nowrap">
                  {"timestamp" in item ? (
                    new Date(item.timestamp * 1000).toISOString()
                  ) : (
                    <span className="text-gray-500">Unknown</span>
                  )}
                </td>
                <td className="p-1 border border-gray-400">
                  {inode ? (
                    <a href={`node_${inode.id}.html`}>{inode.shortname}</a>
                  ) : (
                    <span className="text-gray-500">UNK</span>
                  )}
                </td>
                <td className="p-1 border border-gray-400" align="right">
                  {item.payload.air_util_tx !== undefined &&
                    `${item.payload.air_util_tx.toFixed(2)}%`}
                </td>
                <td className="p-1 border border-gray-400" align="right">
                  {item.payload.channel_utilization !== undefined &&
                    `${item.payload.channel_utilization.toFixed(1)}%`}
                </td>
                <td className="p-1 border border-gray-400" align="right">
                  {item.payload.battery_level !== undefined &&
                    `${item.payload.battery_level.toFixed(2)}%`}
                </td>
                <td className="p-1 border border-gray-400" align="right">
                  {item.payload.uptime_seconds !== undefined &&
                    item.payload.uptime_seconds}
                </td>
                <td
                  className="p-1 border border-gray-400 text-nowrap"
                  align="right"
                >
                  {item.payload.voltage !== undefined &&
                    (typeof item.payload.voltage === "string"
                      ? item.payload.voltage
                      : `${item.payload.voltage.toFixed(2)} V`)}
                  {"voltage_ch1" in item.payload &&
                    "voltage_ch2" in item.payload &&
                    "voltage_ch3" in item.payload && (
                      <table>
                        <tr>
                          <td>Ch1</td>
                          <td align="right" className="pl-2">
                            {item.payload.voltage_ch1.toFixed(2)} V<br />
                          </td>
                        </tr>
                        <tr>
                          <td>Ch2</td>
                          <td align="right" className="pl-2">
                            {item.payload.voltage_ch2.toFixed(2)} V<br />
                          </td>
                        </tr>
                        <tr>
                          <td>Ch3</td>
                          <td align="right" className="pl-2">
                            {item.payload.voltage_ch3.toFixed(2)} V
                          </td>
                        </tr>
                      </table>
                    )}
                </td>
                <td
                  className="hidden lg:table-cell p-1 border border-gray-400 text-nowrap"
                  align="right"
                >
                  {"current" in item.payload &&
                    (typeof item.payload.current === "string"
                      ? item.payload.current
                      : `${item.payload.current.toFixed(2)} mA`)}
                  {"current_ch1" in item.payload &&
                    "current_ch2" in item.payload &&
                    "current_ch3" in item.payload && (
                      <table>
                        <tr>
                          <td>Ch1</td>
                          <td align="right" className="pl-2">
                            {item.payload.current_ch1.toFixed(2)} mA
                            <br />
                          </td>
                        </tr>
                        <tr>
                          <td>Ch2</td>
                          <td align="right" className="pl-2">
                            {item.payload.current_ch2.toFixed(2)} mA
                            <br />
                          </td>
                        </tr>
                        <tr>
                          <td>Ch3</td>
                          <td align="right" className="pl-2">
                            {item.payload.current_ch3.toFixed(2)} mA
                          </td>
                        </tr>
                      </table>
                    )}
                </td>
                <td
                  className="hidden lg:table-cell p-1 border border-gray-400 text-nowrap"
                  align="right"
                >
                  {item.payload.barometric_pressure !== undefined &&
                    `${item.payload.barometric_pressure.toFixed(2)} hPa`}
                </td>
                <td
                  className="hidden lg:table-cell p-1 border border-gray-400 text-nowrap"
                  align="right"
                >
                  {item.payload.relative_humidity !== undefined &&
                    (typeof item.payload.relative_humidity === "string"
                      ? item.payload.relative_humidity
                      : `${item.payload.relative_humidity.toFixed(2)}%`)}
                </td>
                <td
                  className="hidden lg:table-cell p-1 border border-gray-400 text-nowrap"
                  align="right"
                >
                  {item.payload.temperature !== undefined &&
                    `${item.payload.temperature.toFixed(2)} °C`}
                </td>
                <td
                  className="hidden lg:table-cell p-1 border border-gray-400 text-nowrap"
                  align="right"
                >
                  {item.payload.gas_resistance !== undefined &&
                    `${item.payload.gas_resistance.toFixed(2)} Ohm`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};
