import { Link } from "react-router-dom";

import { useGetConfigQuery } from "../slices/apiSlice";

export const HeardBy = () => {
  const { data: config } = useGetConfigQuery();

  return (
    <>
      {" "}
      that have been heard by the mesh by{" "}
      <Link
        to={`/nodes/${config?.server?.node_id}`}
        className="dark:text-indigo-400 dark:visited:text-indigo-400 dark:hover:text-indigo-500"
      >
        {config?.server?.node_id}
      </Link>{" "}
      ({config?.server?.node_id})
    </>
  );
};
