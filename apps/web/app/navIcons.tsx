import AccountTreeOutlined from '@mui/icons-material/AccountTreeOutlined';
import AdminPanelSettingsOutlined from '@mui/icons-material/AdminPanelSettingsOutlined';
import AssignmentIndOutlined from '@mui/icons-material/AssignmentIndOutlined';
import BadgeOutlined from '@mui/icons-material/BadgeOutlined';
import BuildOutlined from '@mui/icons-material/BuildOutlined';
import BusinessOutlined from '@mui/icons-material/BusinessOutlined';
import DescriptionOutlined from '@mui/icons-material/DescriptionOutlined';
import GroupOutlined from '@mui/icons-material/GroupOutlined';
import HomeOutlined from '@mui/icons-material/HomeOutlined';
import LocalShippingOutlined from '@mui/icons-material/LocalShippingOutlined';
import NotificationsActiveOutlined from '@mui/icons-material/NotificationsActiveOutlined';
import TuneOutlined from '@mui/icons-material/TuneOutlined';
import UploadFileOutlined from '@mui/icons-material/UploadFileOutlined';
import VerifiedUserOutlined from '@mui/icons-material/VerifiedUserOutlined';
import type { SvgIconComponent } from '@mui/icons-material';

/** Decorative icon of each navigation entry, by route id. The label is always visible next to it. */
export const navIcons: Readonly<Record<string, SvgIconComponent>> = {
  home: HomeOutlined,
  employees: BadgeOutlined,
  areas: AccountTreeOutlined,
  vehicles: LocalShippingOutlined,
  assignments: AssignmentIndOutlined,
  documents: DescriptionOutlined,
  policies: VerifiedUserOutlined,
  alerts: NotificationsActiveOutlined,
  maintenance: BuildOutlined,
  imports: UploadFileOutlined,
  alertSettings: TuneOutlined,
  company: BusinessOutlined,
  users: GroupOutlined,
  roles: AdminPanelSettingsOutlined,
};
