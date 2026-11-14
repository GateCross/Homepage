import { createContext, useContext, type ReactNode } from "react";

/** 分组是否处于展开可见态；折叠时子组件应暂停轮询 */
const GroupActiveContext = createContext(true);

export function useGroupActive(): boolean {
  return useContext(GroupActiveContext);
}

export function GroupActiveProvider({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}): ReactNode {
  return (
    <GroupActiveContext.Provider value={active}>
      {children}
    </GroupActiveContext.Provider>
  );
}
