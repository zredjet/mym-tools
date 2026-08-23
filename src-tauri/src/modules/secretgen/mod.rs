use crate::module::ModuleBackend;

pub struct SecretGeneratorModule;
impl ModuleBackend for SecretGeneratorModule {
    fn id(&self) -> &'static str {
        "secretgen"
    }
    fn is_stateless(&self) -> bool {
        true
    }
}
