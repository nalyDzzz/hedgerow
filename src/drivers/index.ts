import type { Driver, DriverId } from '@shared/driver'
import { mysqlDriver } from './mysql'

/** Every database the app can talk to. Register new drivers here. */
export const drivers: Record<DriverId, Driver> = {
  mysql: mysqlDriver,
}
