import { ModuleProvider, Modules } from "@medusajs/framework/utils"
import PayzumProviderService from "./service.js"

/**
 * Medusa v2 module-provider export. Register in medusa-config under the Payment module's providers.
 */
export default ModuleProvider(Modules.PAYMENT, {
  services: [PayzumProviderService],
})
