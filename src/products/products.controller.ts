import { Controller, Get, Header, NotFoundException, Param, ParseUUIDPipe } from '@nestjs/common';
import {
  type CatalogPlan,
  type CatalogProduct,
  type CatalogProductDetails,
  ProductsService,
} from './products.service.js';

export type { CatalogPlan, CatalogProduct, CatalogProductDetails };

@Controller('products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Get()
  list(): Promise<CatalogProduct[]> {
    return this.productsService.listActiveProducts();
  }

  @Get(':id/plans')
  @Header('Cache-Control', 'no-store')
  async getPlans(@Param('id', ParseUUIDPipe) id: string): Promise<CatalogProductDetails> {
    const product = await this.productsService.getProductWithPlans(id);
    if (!product) throw new NotFoundException();
    return product;
  }
}
