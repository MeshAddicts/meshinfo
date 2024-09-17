import { NodeRole, roleTitles } from "../types";

export const Role = ({ role }: { role: NodeRole | undefined }) => {
  if (!role) {
    return <span title="Client">C</span>
  }
  const roleInfo = roleTitles[role];
  return <span title={roleInfo?.title}>{roleInfo?.abbreviation}</span>;
};
