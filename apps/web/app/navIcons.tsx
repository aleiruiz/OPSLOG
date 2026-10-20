import AccountTreeOutlined from '@mui/icons-material/AccountTreeOutlined';
import AdminPanelSettingsOutlined from '@mui/icons-material/AdminPanelSettingsOutlined';
import AssignmentIndOutlined from '@mui/icons-material/AssignmentIndOutlined';
import BadgeOutlined from '@mui/icons-material/BadgeOutlined';
import BuildOutlined from '@mui/icons-material/BuildOutlined';
import BusinessOutlined from '@mui/icons-material/BusinessOutlined';
import DescriptionOutlined from '@mui/icons-material/DescriptionOutlined';
import GroupOutlined from '@mui/icons-material/GroupOutlined';
import FactCheckOutlined from '@mui/icons-material/FactCheckOutlined';
import HomeOutlined from '@mui/icons-material/HomeOutlined';
import ReportProblemOutlined from '@mui/icons-material/ReportProblemOutlined';
import LocalShippingOutlined from '@mui/icons-material/LocalShippingOutlined';
import NotificationsActiveOutlined from '@mui/icons-material/NotificationsActiveOutlined';
import TuneOutlined from '@mui/icons-material/TuneOutlined';
import SettingsEthernetOutlined from '@mui/icons-material/SettingsEthernetOutlined';
import UploadFileOutlined from '@mui/icons-material/UploadFileOutlined';
import VerifiedUserOutlined from '@mui/icons-material/VerifiedUserOutlined';

/** Decorative icon of each navigation entry, by route id. The label is always visible next to it. */
export const navIcons: Readonly<Record<string, typeof HomeOutlined>> = {
  home: HomeOutlined,
  employees: BadgeOutlined,
  areas: AccountTreeOutlined,
  vehicles: LocalShippingOutlined,
  assignments: AssignmentIndOutlined,
  documents: DescriptionOutlined,
  policies: VerifiedUserOutlined,
  alerts: NotificationsActiveOutlined,
  maintenance: BuildOutlined,
  incidents: ReportProblemOutlined,
  imports: UploadFileOutlined,
  audit: FactCheckOutlined,
  alertSettings: TuneOutlined,
  integrations: SettingsEthernetOutlined,
  company: BusinessOutlined,
  users: GroupOutlined,
  roles: AdminPanelSettingsOutlined,
};
