import { Module } from '@nestjs/common';
import { TerraformService } from './terraform.service';
import { TerraformController } from './terraform.controller';
import { TerraformRunner } from './terraform.runner';
import { GithubClient } from './github.client';
import { SecretsModule } from '../secrets/secrets.module';

@Module({
  imports: [SecretsModule],
  providers: [TerraformService, TerraformRunner, GithubClient],
  controllers: [TerraformController],
  exports: [TerraformService, GithubClient],
})
export class TerraformModule {}
