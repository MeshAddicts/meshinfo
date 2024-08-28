import { NodeRole, roleTitles } from "../types";

export const Role = ({ role }: { role: NodeRole }) => {
  const roleInfo = roleTitles[role];
  return <span title={roleInfo?.title}>{roleInfo?.abbreviation}</span>;
};
