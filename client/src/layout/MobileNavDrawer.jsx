import Drawer from "../components/ui/Drawer";
import NavList from "./NavList";

export default function MobileNavDrawer({ open, onClose, items }) {
  return (
    <Drawer open={open} onClose={onClose} side="left" title="The Builders' Lab">
      <NavList items={items} onNavigate={onClose} theme="light" />
    </Drawer>
  );
}
