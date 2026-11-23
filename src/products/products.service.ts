import { Injectable } from '@nestjs/common';
import type { PlanHandleType } from '../generated/prisma/client.js';
import {
  parsePlanHandleConfig,
  type PlanHandleConfig,
} from '../orders/handle-type.types.js';
import { PrismaService } from '../prisma/prisma.service.js';

export interface CatalogProduct {
  id: string;
  name: string;
  slug: string;
  image: string | null;
  descriptionVi: string | null;
  descriptionEn: string | null;
}

export interface CatalogPlan {
  id: string;
  code: string;
  nameVi: string;
  nameEn: string;
  price: string;
  currency: string;
  durationDays: number;
  warrantyDays: number;
  stockQuantity: number;
  handleType: PlanHandleType;
  handleConfig: PlanHandleConfig;
}

export interface CatalogProductDetails extends CatalogProduct {
  plans: CatalogPlan[];
}

@Injectable()
export class ProductsService {
  constructor(private readonly prisma: PrismaService) {}

  async listActiveProducts(): Promise<CatalogProduct[]> {
    return this.prisma.product.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        name: true,
        slug: true,
        image: true,
        descriptionVi: true,
        descriptionEn: true,
      },
    });
  }

  async getProductWithPlans(productId: string): Promise<CatalogProductDetails | null> {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, isActive: true },
      select: {
        id: true,
        name: true,
        slug: true,
        image: true,
        descriptionVi: true,
        descriptionEn: true,
        plans: {
          where: { isActive: true },
          orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            code: true,
            nameVi: true,
            nameEn: true,
            price: true,
            currency: true,
            durationDays: true,
            warrantyDays: true,
            stockQuantity: true,
            handleType: true,
            handleConfig: true,
          },
        },
      },
    });

    if (!product) return null;

    return {
      id: product.id,
      name: product.name,
      slug: product.slug,
      image: product.image,
      descriptionVi: product.descriptionVi,
      descriptionEn: product.descriptionEn,
      plans: product.plans.map((plan) => ({
        id: plan.id,
        code: plan.code,
        nameVi: plan.nameVi,
        nameEn: plan.nameEn,
        price: plan.price.toString(),
        currency: plan.currency,
        durationDays: plan.durationDays,
        warrantyDays: plan.warrantyDays,
        stockQuantity: plan.stockQuantity,
        handleType: plan.handleType,
        handleConfig: parsePlanHandleConfig(plan.handleConfig),
      })),
    };
  }

  async getActivePlanById(planId: string) {
    return this.prisma.plan.findFirst({
      where: {
        id: planId,
        isActive: true,
        product: { isActive: true },
      },
      include: { product: true },
    });
  }
}
