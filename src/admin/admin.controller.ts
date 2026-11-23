import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import { AdminGuard } from './admin.guard.js';

@Controller('admin')
@UseGuards(AdminGuard)
export class AdminController {
  @Get()
  @Header('Cache-Control', 'no-store')
  getAdminRole(): { role: 'admin' } {
    return { role: 'admin' };
  }
}
